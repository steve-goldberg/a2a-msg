import type { Register } from "claude-code"
import type { HdrPeer } from "../types"

const HUB = "http://127.0.0.1:8766"
const peersRef = { plugin: "hdr-probe", key: "peers" } as const
const draftRef = { plugin: "hdr-probe", key: "draft" } as const
const PARTIAL = /(?:@hdr-|\$)([A-Za-z0-9._:-]*)$/
const MARK = "[hdr message from "
const cmdName = (p: HdrPeer) => `${p.kind}-${p.name}`.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 64)

// Claude's /rename writes custom-title rows; last one wins. grep, not $.fs.read (4 MiB cap).
async function sessionName($: any): Promise<string> {
  const id = await $.session.id(); const home = (await $.env.get("HOME")) ?? ""
  const found = await $.process.run(["find", `${home}/.claude/projects`, "-maxdepth", "2", "-name", `${id}.jsonl`])
  const file = found.stdout.split("\n")[0]
  if (!file) return ""
  const rows = (await $.process.run(["grep", "-h", '"custom-title"', file])).stdout.trim().split("\n").filter(Boolean)
  for (const row of rows.reverse()) { try { const r = JSON.parse(row); if (r.type === "custom-title" && r.customTitle) return String(r.customTitle) } catch {} }
  return ""
}
async function hello($: any) {
  const pane = (await $.env.get("HERDR_PANE_ID")) ?? ""
  await $.http.fetch(`${HUB}/hello`, { method: "POST", body: JSON.stringify({ pane, name: await sessionName($) }) })
}

export const register: Register = on => {
  let running = false
  on("turn.start", ($, e, next) => { running = true; return next(e) })
  on("turn.complete", ($, e, next) => { running = false; return next(e) })

  on("session.start", async ($, e, next) => {
    const started = await next(e)
    const pane = (await $.env.get("HERDR_PANE_ID")) ?? ""
    await $.tool.register({
      name: "send",
      description: "Send a message to a Herdr peer by pane ID. Delivered headless through the hub; success means delivered to the peer session, not acted on.",
      inputSchema: { type: "object", properties: { target: { type: "string" }, message: { type: "string" } }, required: ["target", "message"] },
    })
    const name = await sessionName($)
    void (async () => {
      const hub = $.process.spawn({ argv: ["node", `${$.plugin.root}/hub-client.mjs`, HUB, pane, "cld", name] })
      let buf = ""
      for await (const { stream, text } of hub) {
        if (stream !== "stdout") continue
        buf += text
        let i
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i); buf = buf.slice(i + 1)
          const msg = JSON.parse(line) as { type: string; peers?: HdrPeer[]; from?: HdrPeer; text?: string }
          if (msg.type === "peers") {
            await $.state.set(peersRef, msg.peers ?? [])
            for (const p of msg.peers ?? []) if (p.kind === "pi") await $.command.register({ name: cmdName(p), description: `Message Pi · ${p.name} · ${p.pane}`, argumentHint: "<message>", immediate: true })
            $.ui.invalidate("command.describe")
          }
          if (msg.type === "message" && msg.from) {
            const text = `${MARK}@hdr-${msg.from.kind}-${msg.from.name} (pane ${msg.from.pane})]\n${msg.text}`
            $.ui.log(`hdr inbound (running=${running})`, { to: "debug" })
            if (running) {
              await $.session.append({ message: { type: "user", content: [{ type: "text", text }] } })
              $.ui.log(`↘ @hdr-${msg.from.kind}-${msg.from.name}: ${msg.text}`)
            }
            else await $.prompt.submit({ text })
          }
        }
      }
    })()
    return started
  })

  // Claude's own SendMessage reaches Pi peers: answer the send for hub names, pass the rest on.
  on("session.send", async ($, e, next) => {
    const { value: peers = [] } = await $.state.get(peersRef)
    const to = String(e.to).replace(/^@/, "")
    const peer = peers.find(p => to === `hdr-${p.kind}-${p.name}` || to === `${p.kind}-${p.name}` || to === p.pane)
    if (!peer) return next(e)
    const from = (await $.env.get("HERDR_PANE_ID")) ?? ""
    const r = await $.http.fetch(`${HUB}/send`, { method: "POST", body: JSON.stringify({ from, target: peer.pane, message: e.text }) })
    return r.ok ? { isDelivered: true as const } : { isDelivered: false as const, reason: `hub refused: ${r.status}` }
  })

  on("command.describe", async ($, e, next) => {
    const r = await next(e)
    if (e.command.startsWith("pi-")) $.ui.log(`describe ${e.command} provider=${JSON.stringify(e.provider)}`, { to: "debug" })
    if (!e.command.startsWith("pi-") || !String((e.provider as { plugin?: string }).plugin).startsWith("hdr-probe")) return r
    const { value: peers = [] } = await $.state.get(peersRef)
    const live = peers.some(p => cmdName(p) === e.command)
    $.ui.log(`describe ${e.command} live=${live}`, { to: "debug" })
    return live ? r : { ...r, isHidden: true }
  })

  on("command.run", async ($, e, next) => {
    const { value: peers = [] } = await $.state.get(peersRef)
    const peer = peers.find(p => cmdName(p) === e.command)
    if (!peer) return next(e)
    const from = (await $.env.get("HERDR_PANE_ID")) ?? ""
    const r = await $.http.fetch(`${HUB}/send`, { method: "POST", body: JSON.stringify({ from, target: peer.pane, message: e.args }) })
    return r.ok ? { text: `↗ @${e.command}: ${e.args}`, context: [`You (via the person) messaged Herdr peer ${e.command} (pane ${peer.pane}): ${e.args}`] } : { text: `hub refused: ${r.status}` }
  })

  on("command.run", { command: "rename" }, async ($, e, next) => { const r = await next(e); await hello($); return r })

  on("tool.call", { tool: "mcp__hdr-probe__send" }, async ($, e) => {
    const from = (await $.env.get("HERDR_PANE_ID")) ?? ""
    const r = await $.http.fetch(`${HUB}/send`, { method: "POST", body: JSON.stringify({ from, target: String(e.target), message: String(e.message) }) })
    return r.ok ? { result: "delivered", text: "delivered" } : { isError: true as const, text: `hub refused: ${r.status} ${r.text}` }
  })

  // Hub messages: one compact line; ctrl+o (isExpanded) shows the engine's full row.
  on("prompt.edit", async ($, e, next) => {
    $.ui.log(`edit key=${JSON.stringify(e.key ?? null)} input=${JSON.stringify(e.inputText)} start=${e.start} end=${e.end}`, { to: "debug" })
    const box = await next(e)
    $.ui.log(`box=${JSON.stringify(box)}`, { to: "debug" })
    await $.state.set(draftRef, box.text)
    if (e.inputText !== " ") return box
    const before = box.text.slice(0, box.cursor - 1)
    const m = PARTIAL.exec(before)
    if (!m) return box
    const { value: peers = [] } = await $.state.get(peersRef)
    const hits = peers.filter(p => p.name.startsWith(m[1]) || `${p.kind}-${p.name}`.startsWith(m[1]))
    if (hits.length !== 1) return box
    const token = `@hdr-${hits[0].kind}-${hits[0].name}`
    const text = before.slice(0, m.index) + token + box.text.slice(box.cursor - 1)
    return { text, cursor: m.index + token.length + 1 }
  })

  on("prompt.submit", async ($, e, next) => {
    const { value: peers = [] } = await $.state.get(peersRef)
    const named = peers.filter(p => e.text.includes(`@hdr-${p.kind}-${p.name}`))
    if (!named.length) return next(e)
    const ctx = named.map(p => `Herdr peer @hdr-${p.kind}-${p.name}: pane ${p.pane}. Message it with mcp__hdr-probe__send.`)
    return next({ ...e, context: [...(e.context ?? []), ...ctx] })
  })

  on("ui.render", { component: "AbovePrompt" }, async ($, e, next) => {
    const { value: draft = "" } = await $.state.get(draftRef)
    const m = PARTIAL.exec(draft)
    $.ui.log(`band draft=${JSON.stringify(draft)} match=${JSON.stringify(m?.[1] ?? null)} collapsed? props=${JSON.stringify(e.props).slice(0, 200)}`, { to: "debug" })
    if (!m) return next(e)
    const { value: peers = [] } = await $.state.get(peersRef)
    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        {peers.filter(p => p.name.startsWith(m[1]) || `${p.kind}-${p.name}`.startsWith(m[1])).map(p => <Text>{`@hdr-${p.kind}-${p.name}  ${p.pane}`}</Text>)}
      </Box>
    )
  })
}
