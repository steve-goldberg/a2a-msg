// a2a-msg for Claude Code (SPEC.md §4): message Pi peers in this Herdr workspace.
//
// - /msg opens a picker of live Pi peers and inserts `@pi-<name>`; Claude↔Claude stays native.
// - On submit, each mentioned Pi peer is described to Claude, which writes the message with its own
//   SendMessage; the session.send hook POSTs it to the peer's Unix socket.
// - inbox.ts (a Node helper on this pane's socket) prints each received message: idle, it becomes a
//   prompt (compacted by a2a-msg-view); mid-turn, it joins the running turn with a visible log line.
import { atom, read, update } from "claude-code"
import type { EngineInterface, Register } from "claude-code"
import {
  baseToken, compactLine, displayName, identity, inboundText, isPong, KIND_LABEL, makeRecord, matchPeers, mentionContext,
  mentions, messageBody, PANE_ID, parseLabels, parseRecord, paths, registryRoot, toPeers, type Identity, type Message,
  type Peer, type PeerRecord,
} from "./core.ts"

const PICKER = "a2a-msg"
const SEND_WITH = "use SendMessage"
const PING_MS = 1500
const SEND_MS = 10_000
const peersAtom = atom({ plugin: "a2a-msg", key: "peers" } as const, [] as Peer[])
const runningRef = { plugin: "a2a-msg", key: "running" } as const
const ownerRef = { plugin: "a2a-msg", key: "owner" } as const

type Env = { me: Identity; root: string; own: ReturnType<typeof paths> }
// Set by session.start (which every load and reload runs); a /clear keeps the module, so it stays.
let env: Env | undefined
let session = ""

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err))

/** This process's identity, or why messaging is off; undefined outside Herdr. */
async function setup($: EngineInterface): Promise<Env | undefined> {
  const herdrEnv = await $.env.get("HERDR_ENV")
  if (herdrEnv !== "1") return undefined
  const me = identity({ HERDR_ENV: herdrEnv, HERDR_PANE_ID: await $.env.get("HERDR_PANE_ID") })
  const root = registryRoot({ A2A_MSG_DIR: await $.env.get("A2A_MSG_DIR"), HOME: await $.env.get("HOME") })
  // HERDR_PANE_ID is inherited: a `claude` or `pi` started by this pane's agent must not take its pane.
  const owner = await $.env.get("A2A_MSG_OWNER")
  const { value: mine } = await $.state.get(ownerRef)
  if (owner && owner !== mine) throw new Error(`pane ${me.pane} belongs to the agent that started this process`)
  const token = mine ?? crypto.randomUUID()
  await $.state.set(ownerRef, token)
  await $.env.set("A2A_MSG_OWNER", token)
  return { me, root, own: paths(root, me.pane) }
}

/** The session's name: the last custom-title row of its transcript (too big for $.fs.read). */
async function sessionName($: EngineInterface): Promise<string> {
  const id = await $.session.id()
  const home = (await $.env.get("HOME")) ?? ""
  const found = await $.process.run(["find", `${home}/.claude/projects`, "-maxdepth", "2", "-name", `${id}.jsonl`])
  const file = found.stdout.split("\n")[0]
  if (!file) return ""
  const rows = (await $.process.run(["grep", "-h", '"custom-title"', file])).stdout.trim().split("\n").filter(Boolean)
  for (const row of rows.reverse()) {
    try {
      const r = JSON.parse(row)
      if (r.type === "custom-title" && typeof r.customTitle === "string") return r.customTitle
    } catch {
      // a row that is not JSON is not a title
    }
  }
  return ""
}

/** Writes this pane's record: a temp file moved into place, so readers never see half of one. */
async function writeRecord($: EngineInterface, e: Env) {
  session = await sessionName($)
  const tmp = `${e.own.record}.tmp`
  await $.fs.write(tmp, JSON.stringify(makeRecord("claude", e.me, session, e.own.sock)))
  const mv = await $.process.run(["mv", "-f", tmp, e.own.record])
  if (mv.exitCode !== 0) throw new Error(`mv ${tmp}: ${mv.stderr.trim()}`)
}

/** One request over a peer's socket; rejects after `ms` (a stopped peer never answers). */
async function call($: EngineInterface, sock: string, path: string, ms: number, body?: string) {
  const stop = new AbortController()
  const timeout = $.clock.sleep(ms, { signal: stop.signal }).then(
    () => { throw new Error(`no answer within ${ms} ms`) },
    () => new Promise<never>(() => {}))
  const request = $.http.fetch(`http://peer${path}`, { method: body === undefined ? "GET" : "POST", socketPath: sock, body,
    headers: { "content-type": "application/json" } })
  try {
    return await Promise.race([request, timeout])
  } finally {
    stop.abort()
  }
}

/** A crashed peer (refused, or its socket gone): delete its files, unless it rewrote its record meanwhile. */
async function removeStale($: EngineInterface, e: Env, r: PeerRecord) {
  const file = paths(e.root, r.pane).record
  let now: PeerRecord | undefined
  try { now = parseRecord(await $.fs.read(file), e.me.workspace, e.root) } catch { return }
  if (now?.updatedAt !== r.updatedAt) return
  await $.process.run(["rm", "-f", file, r.sock])
}

async function alive($: EngineInterface, e: Env, r: PeerRecord): Promise<boolean> {
  try {
    const res = await call($, r.sock, "/ping", PING_MS)
    return res.ok && isPong(res.text, r)
  } catch (err) {
    if (/ECONNREFUSED|ENOENT/.test(errorText(err))) await removeStale($, e, r)
    return false
  }
}

/** Live Pi peers of this workspace, and the Herdr labels they were named with. */
async function scan($: EngineInterface, e: Env): Promise<{ peers: Peer[]; labels: Record<string, string> }> {
  const listed = await $.process.run(["herdr", "pane", "list", "--workspace", e.me.workspace])
  if (listed.exitCode !== 0) throw new Error(`herdr pane list failed: ${listed.stderr.trim() || `exit ${listed.exitCode}`}`)
  const labels = parseLabels(listed.stdout)
  const records: PeerRecord[] = []
  if (await $.fs.exists(e.own.dir)) {
    for (const f of await $.fs.list(e.own.dir)) {
      if (f.kind !== "file" || !f.name.endsWith(".json")) continue
      let text: string
      try { text = await $.fs.read(`${e.own.dir}/${f.name}`) } catch { continue } // removed since listed
      const r = parseRecord(text, e.me.workspace, e.root)
      if (r?.kind === "pi") records.push(r)
    }
  }
  const live = await Promise.all(records.map(r => alive($, e, r)))
  return { peers: toPeers(records.filter((_, i) => live[i]), labels), labels }
}

/** Hands a received message to Claude: a prompt when idle, else a row of the running turn. */
async function receive($: EngineInterface, m: Message) {
  const text = inboundText(m, SEND_WITH)
  const { value: running = false } = await $.state.get(runningRef)
  if (!running) return void (await $.prompt.submit({ text }))
  await $.session.append({ message: { type: "user", content: [{ type: "text", text }] } })
  $.ui.log(compactLine(baseToken(m.from.kind, m.from.name, m.from.pane), m.text))
}

/** Runs the inbox helper for the module's life; the record is written once it listens. */
async function runInbox($: EngineInterface, e: Env) {
  const inbox = $.process.spawn({ argv: ["node", `${$.plugin.root}/inbox.ts`, e.own.sock, "claude", e.me.pane] })
  let buf = ""
  for await (const { stream, text } of inbox) {
    if (stream === "stderr") { $.ui.log(`a2a-msg inbox: ${text.trim()}`); continue }
    buf += text
    for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
      const line = JSON.parse(buf.slice(0, i))
      buf = buf.slice(i + 1)
      try {
        if (line.ready) await writeRecord($, e)
        else await receive($, line as Message)
      } catch (err) {
        $.ui.log(`a2a-msg: ${errorText(err)}`)
      }
    }
  }
  const { code, signal } = await inbox.result
  $.ui.log(`a2a-msg is off: the inbox stopped (${signal ?? `exit ${code}`})`)
}

export const register: Register = on => {
  on("turn.start", async ($, e, next) => { await $.state.set(runningRef, true); return next(e) })
  on("turn.complete", async ($, e, next) => { await $.state.set(runningRef, false); return next(e) })

  on("session.start", async ($, e, next) => {
    const started = await next(e)
    env = undefined
    let e2: Env | undefined
    try {
      e2 = await setup($)
    } catch (err) {
      $.ui.log(`a2a-msg is off: ${errorText(err)}`)
      return started
    }
    if (!e2) return started
    env = e2
    await $.command.register({ name: "msg", description: "Message a Pi peer in this Herdr workspace", immediate: true })
    void runInbox($, e2).catch(err => $.ui.log(`a2a-msg is off: ${errorText(err)}`))
    return started
  })

  on("command.run", { command: "rename" }, async ($, e, next) => {
    const r = await next(e)
    if (env) await writeRecord($, env).catch(err => $.ui.log(`a2a-msg: ${errorText(err)}`))
    return r
  })

  // /clear ends the conversation, not the process: the record stays then.
  on("session.end", async ($, e, next) => {
    if (env && e.reason !== "clear") await $.process.run(["rm", "-f", env.own.record, env.own.sock])
    return next(e)
  })

  // /msg: the picker, from peers read fresh each time it opens.
  on("command.run", { command: "msg" }, async ($, e) => {
    if (!env) return { text: "a2a-msg is off in this session." }
    let peers: Peer[]
    try {
      peers = (await scan($, env)).peers
    } catch (err) {
      return { text: `a2a-msg: ${errorText(err)}` }
    }
    if (!peers.length) return { text: "No live Pi peers in this Herdr workspace." }
    await update($, peersAtom, () => peers)
    await $.ui.open({ id: PICKER, title: "Message a Pi peer", focus: true, closeOnEscape: true, rows: peers.length + 3 })
    return {}
  })

  on("ui.render", { component: "Pane", requestId: PICKER }, async ($, e) => {
    const elements = $.ui.resolve(e)
    const { Box, Text } = elements
    if (!("Select" in elements)) return <Text dimColor>The /msg picker needs a terminal, desktop or VS Code surface.</Text>
    const { Select } = elements
    const peers = await read($, peersAtom)
    const first = peers[0]
    if (!first) return <Text dimColor>No live Pi peers.</Text>
    return (
      <Box flexDirection="column">
        <Select
          key="peer"
          autoFocus
          value={first.pane}
          options={peers.map(p => ({ value: p.pane, label: `${p.name}  ${KIND_LABEL[p.kind]} · ${p.pane}` }))}
          onSelect={async pane => {
            const peer = peers.find(p => p.pane === pane)
            await $.ui.close({ id: PICKER })
            if (peer) await $.prompt.fill({ text: `@${peer.token} `, mode: "insert" })
          }}
        />
        <Text dimColor>↑↓ choose · Enter insert · Esc cancel</Text>
      </Box>
    )
  })

  // A mentioned Pi peer is described to Claude, as Claude Code describes a mentioned session.
  on("prompt.submit", async ($, e, next) => {
    const tokens = env ? mentions(e.text).filter(t => /^pi-/i.test(t)) : []
    if (!env || !tokens.length) return next(e)
    let peers: Peer[]
    try {
      peers = (await scan($, env)).peers
    } catch (err) {
      $.ui.toast(`a2a-msg: mentions not resolved: ${errorText(err)}`)
      return next(e)
    }
    const found: Peer[] = []
    const missing: string[] = []
    for (const token of tokens) {
      const match = matchPeers(token, peers)
      if (match.length === 1 && match[0]) found.push(match[0])
      else missing.push(match.length ? `@${token} (several: ${match.map(p => p.token).join(", ")})` : `@${token}`)
    }
    if (missing.length) $.ui.toast(`Not a Pi peer in this Herdr workspace: ${missing.join(", ")}`)
    if (!found.length) return next(e)
    return next({ ...e, context: [...(e.context ?? []), ...found.map(p => mentionContext(p, SEND_WITH))] })
  })

  // Claude's own SendMessage reaches a Pi peer by token or pane; every other recipient stays native.
  on("session.send", async ($, e, next) => {
    const to = e.to.trim().replace(/^@/, "")
    if (!env || !(/^pi-/i.test(to) || PANE_ID.test(to))) return next(e)
    let found: Peer[]
    let labels: Record<string, string>
    try {
      const s = await scan($, env)
      found = matchPeers(to, s.peers)
      labels = s.labels
    } catch (err) {
      return { isDelivered: false as const, reason: `a2a-msg: ${errorText(err)}` }
    }
    const peer = found[0]
    if (!peer) return next(e)
    if (found.length > 1) return { isDelivered: false as const, reason: `"${to}" matches several Pi peers: ${found.map(p => p.token).join(", ")}. Use one of those.` }
    const where = `@${peer.token} (${peer.pane})`
    try {
      const body = messageBody({ kind: "claude", pane: env.me.pane, name: displayName(session, labels[env.me.pane], env.me.pane) }, e.text, crypto.randomUUID())
      const res = await call($, peer.sock, "/msg", SEND_MS, body)
      if (!res.ok) return { isDelivered: false as const, reason: `Not delivered to ${where}: HTTP ${res.status} ${res.text}` }
    } catch (err) {
      return { isDelivered: false as const, reason: `Not delivered to ${where}: ${errorText(err)}` }
    }
    return { isDelivered: true as const }
  })
}
