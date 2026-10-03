import { atom, read, update } from "claude-code"
import type { Register } from "claude-code"
import type { Peer } from "../types"

const DIR = "/tmp/hdr-peers"
const PICKER = "msg"
const peersAtom = atom({ plugin: "hdr-probe2", key: "peers" } as const, [] as Peer[])
const runningRef = { plugin: "hdr-probe2", key: "running" } as const
const MENTION = /@(pi|cld)-([A-Za-z0-9._-]+)/g
const safe = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, "_")
const token = (p: Peer) => `${p.kind}-${p.name}`.replace(/[^A-Za-z0-9._-]/g, "-")

async function sessionName($: any): Promise<string> {
  const id = await $.session.id(); const home = (await $.env.get("HOME")) ?? ""
  const file = (await $.process.run(["find", `${home}/.claude/projects`, "-maxdepth", "2", "-name", `${id}.jsonl`])).stdout.split("\n")[0]
  if (!file) return ""
  const rows = (await $.process.run(["grep", "-h", '"custom-title"', file])).stdout.trim().split("\n").filter(Boolean)
  for (const row of rows.reverse()) { try { const r = JSON.parse(row); if (r.type === "custom-title" && r.customTitle) return String(r.customTitle) } catch {} }
  return ""
}

// Live peers: registry files whose inbox answers; name = session name, else Herdr pane label, else pane ID.
async function livePeers($: any): Promise<Peer[]> {
  const me = (await $.env.get("HERDR_PANE_ID")) ?? ""
  const labels: Record<string, string> = {}
  const listed = await $.process.run(["herdr", "pane", "list", "--workspace", me.split(":")[0]])
  try { for (const p of JSON.parse(listed.stdout).result.panes) if (p.label) labels[p.pane_id] = String(p.label) } catch {}
  const out: Peer[] = []
  for (const f of await $.fs.list(DIR)) {
    if (!f.name.endsWith(".json")) continue
    const rec = JSON.parse(await $.fs.read(`${DIR}/${f.name}`)) as { kind: "pi" | "cld"; pane: string; session: string; sock: string }
    if (rec.pane === me) continue
    const alive = await $.http.fetch("http://peer/ping", { socketPath: rec.sock }).then(
      r => { $.ui.log(`ping ${rec.pane}: resolved status=${r.status} ok=${r.ok}`, { to: "debug" }); return r.ok },
      err => { $.ui.log(`ping ${rec.pane}: rejected ${String(err).slice(0, 120)}`, { to: "debug" }); return false })
    if (alive) out.push({ kind: rec.kind, pane: rec.pane, sock: rec.sock, name: rec.session || labels[rec.pane] || rec.pane })
  }
  return out
}

// The registry record: written at start, rewritten after /rename, removed at exit.
async function writeRecord($: any) {
  const pane = (await $.env.get("HERDR_PANE_ID")) ?? ""
  await $.fs.write(`${DIR}/${safe(pane)}.json`, JSON.stringify({ kind: "cld", pane, session: await sessionName($), sock: `${DIR}/${safe(pane)}.sock` }))
}

async function deliver($: any, peer: Peer, text: string) {
  const pane = (await $.env.get("HERDR_PANE_ID")) ?? ""
  const name = (await sessionName($)) || pane
  return $.http.fetch("http://peer/msg", { method: "POST", socketPath: peer.sock, body: JSON.stringify({ from: { kind: "cld", pane, name }, text }) })
}

export const register: Register = on => {
  on("turn.start", async ($, e, next) => { await $.state.set(runningRef, true); return next(e) })
  on("turn.complete", async ($, e, next) => { await $.state.set(runningRef, false); return next(e) })

  on("session.start", async ($, e, next) => {
    const started = await next(e)
    const pane = (await $.env.get("HERDR_PANE_ID")) ?? ""
    const sock = `${DIR}/${safe(pane)}.sock`
    await $.command.register({ name: "msg", description: "Message a Pi or Claude peer in this Herdr", immediate: true })
    await writeRecord($)
    void (async () => {
      const inbox = $.process.spawn({ argv: ["node", `${$.plugin.root}/listener.mjs`, sock] })
      let buf = ""
      for await (const { stream, text } of inbox) {
        if (stream !== "stdout") continue
        buf += text
        for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
          const msg = JSON.parse(buf.slice(0, i)) as { from: { kind: string; pane: string; name: string }; text: string }
          buf = buf.slice(i + 1)
          const body = `[message from @${msg.from.kind}-${msg.from.name} · ${msg.from.pane}]\n${msg.text}`
          const { value: running = false } = await $.state.get(runningRef)
          if (running) {
            await $.session.append({ message: { type: "user", content: [{ type: "text", text: body }] } })
            $.ui.log(`↘ @${msg.from.kind}-${msg.from.name}: ${msg.text}`)
          } else await $.prompt.submit({ text: body })
        }
      }
    })()
    return started
  })

  on("command.run", { command: "rename" }, async ($, e, next) => { const r = await next(e); await writeRecord($); return r })

  // /clear ends the conversation but not the process: keep the record then.
  on("session.end", async ($, e, next) => {
    if (e.reason !== "clear") {
      const pane = (await $.env.get("HERDR_PANE_ID")) ?? ""
      await $.process.run(["rm", "-f", `${DIR}/${safe(pane)}.json`, `${DIR}/${safe(pane)}.sock`])
    }
    return next(e)
  })

  // /msg: the picker. Peers are read fresh each time it opens.
  on("command.run", { command: "msg" }, async ($, e) => {
    $.ui.log("msg: command.run", { to: "debug" })
    const peers = await livePeers($)
    $.ui.log(`msg: live=${JSON.stringify(peers.map(p => p.pane))}`, { to: "debug" })
    if (!peers.length) return { text: "No live peers." }
    await update($, peersAtom, () => peers)
    await $.ui.open({ id: PICKER, title: "Message a peer", focus: true, closeOnEscape: true, rows: peers.length + 4 })
    return {}
  })

  on("ui.render", { component: "Pane", requestId: PICKER }, async ($, e) => {
    const { Box, Text, Select } = $.ui.resolve(e)
    const peers = await read($, peersAtom)
    return (
      <Box flexDirection="column">
        <Select
          key="peer"
          autoFocus
          options={peers.map(p => ({ value: p.pane, label: `${p.name}  ${p.kind === "pi" ? "Pi" : "Claude"} · ${p.pane}` }))}
          onSelect={async pane => {
            $.ui.log(`msg: onSelect ${pane}`, { to: "debug" })
            const peer = peers.find(p => p.pane === pane)
            await $.ui.close({ id: PICKER })
            if (peer) await $.prompt.fill({ text: `@${token(peer)} `, mode: "insert" })
          }}
        />
        <Text dimColor>↑↓ choose · Enter insert · Esc cancel</Text>
      </Box>
    )
  })

  // A mentioned peer is named for Claude, as Claude Code does for a mentioned session.
  on("prompt.submit", async ($, e, next) => {
    const names = [...e.text.matchAll(MENTION)].map(m => `${m[1]}-${m[2]}`)
    if (!names.length) return next(e)
    const peers = await livePeers($)
    const ctx = peers.filter(p => names.includes(token(p))).map(p =>
      `@${token(p)} is a ${p.kind === "pi" ? "Pi" : "Claude"} session in Herdr pane ${p.pane}. To message it, use SendMessage with to: "${token(p)}".`)
    return next({ ...e, context: [...(e.context ?? []), ...ctx] })
  })

  // Claude's own SendMessage reaches hub-less peers by token or pane.
  on("session.send", async ($, e, next) => {
    const to = String(e.to).replace(/^@/, "")
    const peer = (await livePeers($)).find(p => to === token(p) || to === p.pane)
    if (!peer) return next(e)
    const r = await deliver($, peer, e.text)
    return r.ok ? { isDelivered: true as const } : { isDelivered: false as const, reason: `peer inbox refused: ${r.status}` }
  })
}
