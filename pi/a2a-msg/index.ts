// a2a-msg for Pi (SPEC.md §5): peer messaging over Unix sockets inside one Herdr workspace.
//
// - /msg picks a Claude peer and inserts `@cld-<name>` (the bridge); `@` completes Pi peers (`@pi-<name>`).
// - On submit, each mentioned live peer is described to the model, which writes the message
//   and sends it with the send_message tool (a POST to the peer's socket).
// - An in-process inbox records each receipt as a compact `↘ @token: …` row immediately,
//   independently of when the steered model message can run.
import { execFile } from "node:child_process"
import { randomUUID } from "node:crypto"
import fs from "node:fs"
import http from "node:http"
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent"
import { Box, Text, type AutocompleteItem, type AutocompleteProvider } from "@earendil-works/pi-tui"
import { Type } from "typebox"
import {
  baseToken, compactLine, displayName, identity, inboundText, isPong, KIND_LABEL, matchPeers, mentionContext,
  mentions, messageBody, parseLabels, parseRecord, paths, registryRoot, toPeers, type Identity, type Message, type Peer,
  type PeerRecord,
} from "../../claude/a2a-msg/hooks/core.ts"
import { listen, reap, type Inbox } from "../../claude/a2a-msg/inbox.ts"

const SEND_WITH = "use the send_message tool"
const PING_MS = 1500
const SEND_MS = 10_000
type Details = { token: string; from: Message["from"]; text: string; id: string }
type Scan = { peers: Peer[]; myName: string }

/** Shared by immediate receipt entries and legacy displayed custom messages. */
function inboxRow(d: Details | undefined, expanded: boolean, outputPad: number, theme: Theme) {
  if (!d) return undefined
  const box = new Box(outputPad, 0, text => theme.bg("customMessageBg", text))
  const head = theme.fg("customMessageLabel", `↘ @${d.token}`)
  box.addChild(new Text(expanded
    ? `${head}${theme.fg("dim", ` · ${d.from.pane}`)}\n${theme.fg("customMessageText", d.text)}`
    : `${head}${theme.fg("customMessageText", compactLine(d.token, d.text).slice(`↘ @${d.token}`.length))}`, 0, 0))
  return box
}

/** One HTTP request over a Unix socket, no connection reuse. */
function request(sock: string, method: string, path: string, body: string | undefined, timeoutMs: number) {
  return new Promise<{ status: number; text: string }>((resolve, reject) => {
    const req = http.request({ socketPath: sock, method, path, agent: false, timeout: timeoutMs, headers: { "content-type": "application/json" } }, res => {
      let text = ""
      res.setEncoding("utf8")
      res.on("data", c => (text += c))
      res.on("end", () => resolve({ status: res.statusCode ?? 0, text }))
    })
    req.on("timeout", () => req.destroy(Object.assign(new Error(`no answer within ${timeoutMs} ms`), { code: "ETIMEDOUT" })))
    req.on("error", reject)
    req.end(body)
  })
}

function herdr(args: string[]): Promise<string> {
  return new Promise((resolve, reject) =>
    execFile("herdr", args, { timeout: 5000 }, (err, stdout, stderr) =>
      err ? reject(new Error(`herdr ${args.join(" ")} failed: ${(stderr || err.message).trim()}`)) : resolve(stdout)))
}

/** Pi peers for `@` completion, ahead of the editor's own suggestions. Port of hdr-mcp createMentionProvider. */
export function createMentionProvider(current: AutocompleteProvider, piPeers: (signal: AbortSignal) => Promise<Peer[]>): AutocompleteProvider {
  const ours = new WeakSet<AutocompleteItem>()
  return {
    triggerCharacters: [...new Set([...(current.triggerCharacters ?? []), "@"])],
    async getSuggestions(lines, cursorLine, cursorCol, options) {
      const base = await current.getSuggestions(lines, cursorLine, cursorCol, options)
      const prefix = (lines[cursorLine] ?? "").slice(0, cursorCol).match(/(?:^|[\t ])(@[A-Za-z0-9._-]*)$/)?.[1]
      if (options.signal.aborted || !prefix || (base && base.prefix !== prefix)) return base
      const query = prefix.slice(1).toLowerCase()
      const items = (await piPeers(options.signal))
        .filter(p => p.token.toLowerCase().startsWith(query) || p.name.toLowerCase().includes(query))
        .map(p => {
          const item = { value: `@${p.token}`, label: `@${p.token}`, description: `${KIND_LABEL[p.kind]} · ${p.pane}` }
          ours.add(item)
          return item
        })
      return items.length ? { prefix, items: [...items, ...(base?.items ?? [])] } : base
    },
    applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
      if (!ours.has(item)) return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix)
      const line = lines[cursorLine] ?? ""
      const start = cursorCol - prefix.length
      const rest = line.slice(cursorCol)
      const token = /^\s/.test(rest) ? item.value : `${item.value} `
      const result = [...lines]
      result[cursorLine] = line.slice(0, start) + token + rest
      return { lines: result, cursorLine, cursorCol: start + token.length }
    },
    shouldTriggerFileCompletion: (lines, line, col) => current.shouldTriggerFileCompletion?.(lines, line, col) ?? true,
  }
}

export default function a2aMsg(pi: ExtensionAPI) {
  if (process.env.HERDR_ENV !== "1") return // not inside Herdr: nothing to do
  let me: Identity, root: string, own: ReturnType<typeof paths>
  let off: string | undefined
  try {
    me = identity(process.env)
    root = registryRoot(process.env)
    own = paths(root, me.pane)
    // HERDR_PANE_ID is inherited: a `pi` or `claude` started by this session's tools must not take its pane.
    const owner = process.env.A2A_MSG_OWNER
    if (owner && owner !== String(process.pid)) throw new Error(`pane ${me.pane} belongs to the agent that started this process`)
    process.env.A2A_MSG_OWNER = String(process.pid)
  } catch (err) {
    off = `a2a-msg is off: ${(err as Error).message}`
  }
  if (off) {
    pi.on("session_start", (_e, ctx) => ctx.ui.notify(off, "warning"))
    return
  }

  let server: Inbox | undefined
  let ui: ExtensionContext["ui"] | undefined
  const warned = new Set<string>()

  const writeRecord = () => server?.setSession(pi.getSessionName() ?? "")
  const stop = async () => {
    const previous = server
    server = undefined
    await previous?.close()
  }

  // A failed probe is not proof of a crash while the pane still exists. Readers never unlink
  // socket paths: that can strand a live listener between bind and publication.
  const removeStale = (r: PeerRecord) => {
    const file = paths(root, r.pane).record
    let now: PeerRecord | undefined
    try { now = parseRecord(fs.readFileSync(file, "utf8"), me.workspace, root) } catch { return }
    if (now?.updatedAt !== r.updatedAt) return
    fs.rmSync(file, { force: true })
  }
  const alive = async (r: PeerRecord, labels: Record<string, string>) => {
    try {
      const res = await request(r.sock, "GET", "/ping", undefined, PING_MS)
      return res.status === 200 && isPong(res.text, r)
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === "ECONNREFUSED" || code === "ENOENT") {
        if (r.generation) reap(r)
        else if (!Object.hasOwn(labels, r.pane)) removeStale(r)
      }
      return false
    }
  }

  /** Live peers of this workspace (every kind) and this session's display name. */
  async function scan(): Promise<Scan> {
    const labels = parseLabels(await herdr(["pane", "list", "--workspace", me.workspace]))
    const records = fs.existsSync(own.dir)
      ? fs.readdirSync(own.dir).filter(f => f.endsWith(".json"))
        .flatMap(f => { try { return [fs.readFileSync(`${own.dir}/${f}`, "utf8")] } catch { return [] } })
        .flatMap(text => parseRecord(text, me.workspace, root) ?? [])
        .filter(r => r.pane !== me.pane)
      : []
    const live = (await Promise.all(records.map(async r => ((await alive(r, labels)) ? r : undefined)))).filter(r => r !== undefined)
    return { peers: toPeers(live, labels), myName: displayName(pi.getSessionName(), labels[me.pane], me.pane) }
  }

  async function send(to: string, text: string) {
    const { peers, myName } = await scan()
    const found = matchPeers(to, peers)
    const peer = found[0]
    if (!peer) throw new Error(`No live peer "${to}" in this Herdr workspace; nothing was sent.`)
    if (found.length > 1) throw new Error(`"${to}" matches several peers: ${found.map(p => p.token).join(", ")}. Use one of those.`)
    const body = messageBody({ kind: "pi", pane: me.pane, name: myName }, text, randomUUID())
    let res
    try {
      res = await request(peer.sock, "POST", "/msg", body, SEND_MS)
    } catch (err) {
      throw new Error(`Not delivered to @${peer.token} (${peer.pane}): ${(err as Error).message}`)
    }
    if (res.status !== 200) throw new Error(`Not delivered to @${peer.token} (${peer.pane}): HTTP ${res.status} ${res.text}`)
    return peer
  }

  const deliver = (m: Message) => {
    const token = baseToken(m.from.kind, m.from.name, m.from.pane)
    const details: Details = { token, from: m.from, text: m.text, id: m.id }
    // A streamed custom message emits no UI event until the current tool finishes. Store
    // the receipt now; keep the single steered model message hidden to avoid a second row.
    pi.appendEntry<Details>("a2a-msg", details)
    pi.sendMessage<Details>({ customType: "a2a-msg", content: inboundText(m, SEND_WITH), display: false, details },
      { triggerTurn: true, deliverAs: "steer" })
  }

  pi.on("session_start", async (_e, ctx) => {
    ui = ctx.ui
    try {
      await stop()
      server = await listen(own.sock, "pi", me.pane, deliver, {
        record: own.record, session: pi.getSessionName() ?? "",
        onError: err => ctx.ui.notify(`a2a-msg is off: ${err.message}`, "error"),
      })
    } catch (err) {
      await stop()
      ctx.ui.notify(`a2a-msg is off: ${(err as Error).message}`, "error")
      return
    }
    if (ctx.mode === "tui") {
      ctx.ui.addAutocompleteProvider(current => createMentionProvider(current, async () => {
        try {
          return (await scan()).peers.filter(p => p.kind === "pi")
        } catch (err) {
          const msg = `a2a-msg: no peer completion: ${(err as Error).message}`
          if (!warned.has(msg)) { warned.add(msg); ui?.notify(msg, "error") }
          return []
        }
      }))
    }
  })
  pi.on("session_info_changed", () => { if (server) writeRecord() })
  pi.on("session_shutdown", () => stop())

  pi.registerEntryRenderer<Details>("a2a-msg", (entry, { expanded }, theme) =>
    inboxRow(entry.data, expanded, pi.getSettings().outputPad ?? 1, theme))
  // Existing sessions still contain displayed custom messages from older versions.
  pi.registerMessageRenderer<Details>("a2a-msg", (message, { expanded, outputPad }, theme) =>
    inboxRow(message.details, expanded, outputPad, theme))

  pi.registerCommand("msg", {
    description: "Message a Claude peer in this Herdr workspace",
    handler: async (_args, ctx) => {
      let peers: Peer[]
      try {
        peers = (await scan()).peers.filter(p => p.kind === "claude")
      } catch (err) {
        return ctx.ui.notify(`a2a-msg: ${(err as Error).message}`, "error")
      }
      if (!peers.length) return ctx.ui.notify("No live Claude peers in this Herdr workspace.", "info")
      const rows = peers.map(p => `${p.name}  ${KIND_LABEL[p.kind]} · ${p.pane}`)
      const pick = await ctx.ui.select("Message a Claude peer", rows)
      const peer = pick === undefined ? undefined : peers[rows.indexOf(pick)]
      if (!peer) return
      ctx.ui.pasteToEditor(`@${peer.token} `)
      ctx.ui.setStatus("a2a-msg", undefined) // pasteToEditor does not redraw; setStatus asks for one
    },
  })

  pi.on("before_agent_start", async (event, ctx) => {
    const tokens = mentions(event.prompt)
    if (!tokens.length) return
    let peers: Peer[]
    try {
      peers = (await scan()).peers
    } catch (err) {
      ctx.ui.notify(`a2a-msg: mentions not resolved: ${(err as Error).message}`, "error")
      return
    }
    const found: Peer[] = []
    const missing: string[] = []
    for (const token of tokens) {
      const match = matchPeers(token, peers)
      if (match.length === 1 && match[0]) found.push(match[0])
      else missing.push(match.length ? `@${token} (several: ${match.map(p => p.token).join(", ")})` : `@${token}`)
    }
    if (missing.length) ctx.ui.notify(`Not a peer in this Herdr workspace: ${missing.join(", ")}`, "warning")
    if (!found.length) return
    return { message: { customType: "a2a-msg-mention", display: false, content: found.map(p => mentionContext(p, SEND_WITH)).join("\n\n") } }
  })

  pi.registerTool({
    name: "send_message",
    label: "Send message",
    description: "Send a message to a Pi or Claude peer session in this Herdr workspace, delivered to its prompt. " +
      "`to` is the peer's token as in an @mention (pi-<name> or cld-<name>) or its Herdr pane ID. " +
      "Write a self-contained message. Delivery means submitted to the peer, not done. Never retried.",
    parameters: Type.Object({
      to: Type.String({ description: "Peer token (pi-<name> / cld-<name>, without @) or Herdr pane ID" }),
      message: Type.String({ description: "The message text; newline and tab are the only control characters allowed" }),
    }),
    async execute(_id, params) {
      const peer = await send(params.to, params.message)
      return {
        content: [{ type: "text", text: `Delivered to @${peer.token} (${peer.pane}). Delivery means submitted, not done.` }],
        details: { token: peer.token, pane: peer.pane },
      }
    },
  })
}
