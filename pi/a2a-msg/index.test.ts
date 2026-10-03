// Pi extension tests: a fake `pi`, a fake `herdr` on PATH, a temp registry, real Unix sockets.
// Run: npm test (needs scripts/link-pi.sh once, for the packages Pi provides).
import assert from "node:assert/strict"
import fs from "node:fs"
import http from "node:http"
import { after, before, test } from "node:test"
import { makeRecord, messageBody, paths, type Message } from "../../claude/a2a-msg/hooks/core.ts"
import { listen } from "../../claude/a2a-msg/inbox.ts"
import a2aMsg from "./index.ts"

const ROOT = fs.mkdtempSync("/tmp/a2a-pi-")
const BIN = `${ROOT}/bin`
const ENV = { ...process.env }
const ME = "w1:p9"

function post(sock: string, path: string, body?: string): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath: sock, method: body === undefined ? "GET" : "POST", path, agent: false }, res => {
      let text = ""
      res.on("data", c => (text += c))
      res.on("end", () => resolve({ status: res.statusCode!, text }))
    })
    req.on("error", reject)
    req.end(body)
  })
}

function fakePi(session = "") {
  const handlers: Record<string, any> = {}
  const commands: Record<string, any> = {}
  const tools: Record<string, any> = {}
  const renderers: Record<string, any> = {}
  const sent: any[] = []
  let name = session
  const pi = {
    on: (event: string, h: Function) => { handlers[event] = h },
    registerCommand: (n: string, c: any) => { commands[n] = c },
    registerTool: (t: any) => { tools[t.name] = t },
    registerMessageRenderer: (t: string, r: Function) => { renderers[t] = r },
    sendMessage: (m: any, o: any) => sent.push([m, o]),
    getSessionName: () => name || undefined,
  }
  const rename = (n: string) => { name = n }
  return { pi: pi as any, handlers, commands, tools, renderers, sent, rename }
}

function fakeCtx(pick?: (rows: string[]) => string | undefined) {
  const notes: [string, string][] = []
  const pasted: string[] = []
  const selects: [string, string[]][] = []
  const providers: any[] = []
  const ui = {
    notify: (m: string, t: string) => notes.push([m, t]),
    pasteToEditor: (t: string) => pasted.push(t),
    select: async (title: string, rows: string[]) => { selects.push([title, rows]); return pick?.(rows) },
    addAutocompleteProvider: (f: Function) => providers.push(f),
    setStatus: () => {},
  }
  return { ctx: { mode: "tui", ui } as any, notes, pasted, selects, providers }
}

// A live peer of any kind: its record plus a real inbox that collects what it receives.
async function peer(pane: string, kind: "pi" | "claude", session: string) {
  const p = paths(ROOT, pane)
  const got: Message[] = []
  const server = await listen(p.sock, kind, pane, m => got.push(m))
  fs.writeFileSync(p.record, JSON.stringify(makeRecord(kind, { pane, workspace: "w1" }, session, p.sock)))
  return { got, close: () => server.close() }
}

before(() => {
  fs.mkdirSync(BIN)
  const panes = [{ pane_id: ME, label: "my-label" }, { pane_id: "w1:p2", label: "Files" }]
  fs.writeFileSync(`${BIN}/herdr`, `#!/bin/sh\n[ "$*" = "pane list --workspace w1" ] || { echo "unexpected: $*" >&2; exit 1; }\necho '${JSON.stringify({ result: { panes } })}'\n`, { mode: 0o755 })
  Object.assign(process.env, { HERDR_ENV: "1", HERDR_PANE_ID: ME, A2A_MSG_DIR: ROOT, PATH: `${BIN}:${ENV.PATH}` })
  delete process.env.A2A_MSG_OWNER
})
after(() => {
  process.env = ENV
  fs.rmSync(ROOT, { recursive: true, force: true })
})

test("outside Herdr nothing is registered", () => {
  process.env.HERDR_ENV = "0"
  try {
    const { pi, handlers, commands, tools } = fakePi()
    a2aMsg(pi)
    assert.deepEqual([Object.keys(handlers), Object.keys(commands), Object.keys(tools)], [[], [], []])
  } finally {
    process.env.HERDR_ENV = "1"
  }
})

test("a process started by another agent's tools in the same pane stays off, with a notice", () => {
  process.env.A2A_MSG_OWNER = "1"
  try {
    const { pi, handlers, commands } = fakePi()
    a2aMsg(pi)
    assert.deepEqual([Object.keys(handlers), Object.keys(commands)], [["session_start"], []])
    const { ctx, notes } = fakeCtx()
    handlers.session_start({}, ctx)
    assert.deepEqual(notes, [[`a2a-msg is off: pane ${ME} belongs to the agent that started this process`, "warning"]])
  } finally {
    delete process.env.A2A_MSG_OWNER
  }
})

test("lifecycle, /msg, @ completion, mentions, send_message, inbound, renderer, stale peers", async () => {
  const lead = await peer("w1:p3", "claude", "lead")
  const files = await peer("w1:p2", "pi", "")
  const stale = paths(ROOT, "w1:p5")
  fs.writeFileSync(stale.record, JSON.stringify(makeRecord("pi", { pane: "w1:p5", workspace: "w1" }, "crashed", stale.sock)))
  const own = paths(ROOT, ME)
  const { pi, handlers, commands, tools, renderers, sent, rename } = fakePi()
  a2aMsg(pi)
  assert.equal(process.env.A2A_MSG_OWNER, String(process.pid))
  try {
    // start: record written, inbox answers
    const { ctx, notes, pasted, selects, providers } = fakeCtx(rows => rows[0])
    await handlers.session_start({ reason: "startup" }, ctx)
    assert.deepEqual(JSON.parse(fs.readFileSync(own.record, "utf8")).session, "")
    assert.equal((await post(own.sock, "/ping")).text, '{"v":1,"kind":"pi","pane":"w1:p9"}')

    // /msg lists Claude peers only and pastes the token; the crashed peer's files are deleted
    await commands.msg.handler("", ctx)
    assert.deepEqual(selects, [["Message a Claude peer", ["lead  Claude · w1:p3"]]])
    assert.deepEqual(pasted, ["@cld-lead "])
    assert.equal(fs.existsSync(stale.record), false)

    // @ completion lists Pi peers only (named by Herdr label), ahead of the editor's own items
    const base = { triggerCharacters: ["/"], getSuggestions: async () => null, applyCompletion: () => ({ lines: ["base"], cursorLine: 0, cursorCol: 0 }) }
    const provider = providers[0](base)
    const got = await provider.getSuggestions(["ask @"], 0, 5, { signal: new AbortController().signal })
    assert.deepEqual(got.items.map((i: any) => [i.value, i.description]), [["@pi-Files", "Pi · w1:p2"]])
    assert.deepEqual(provider.applyCompletion(["ask @"], 0, 5, got.items[0], "@"), { lines: ["ask @pi-Files "], cursorLine: 0, cursorCol: 14 })

    // a mention adds hidden context for live peers; unknown ones warn
    const ctxResult = await handlers.before_agent_start({ prompt: "@cld-lead and @pi-gone: status?" }, ctx)
    assert.equal(ctxResult.message.customType, "a2a-msg-mention")
    assert.equal(ctxResult.message.display, false)
    assert.match(ctxResult.message.content, /^@cld-lead is a Claude session in this Herdr workspace \(pane w1:p3\)\. To message it, use the send_message tool with to: "cld-lead"\./)
    assert.deepEqual(notes.at(-1), ["Not a peer in this Herdr workspace: @pi-gone", "warning"])
    assert.equal(await handlers.before_agent_start({ prompt: "no mentions" }, ctx), undefined)

    // send_message reaches the peer's inbox under this session's display name (Herdr label: no session name yet)
    const r = await tools.send_message.execute("id", { to: "cld-lead", message: "the build is green" })
    assert.equal(r.content[0].text, "Delivered to @cld-lead (w1:p3). Delivery means submitted, not done.")
    assert.deepEqual(lead.got.map(m => [m.from, m.text]), [[{ kind: "pi", pane: ME, name: "my-label" }, "the build is green"]])
    await assert.rejects(tools.send_message.execute("id", { to: "pi-nobody", message: "x" }), /No live peer "pi-nobody"/)
    await assert.rejects(tools.send_message.execute("id", { to: "cld-lead", message: "bad\u0007" }), /control characters/)

    // inbound: one steer turn with the reply instructions; rejected bodies never reach Pi
    assert.equal((await post(own.sock, "/msg", messageBody({ kind: "claude", pane: "w1:p3", name: "lead" }, "rebase now\nthen test", "m1"))).status, 200)
    assert.equal((await post(own.sock, "/msg", messageBody({ kind: "claude", pane: "w2:p3", name: "x" }, "x", "m2"))).status, 403)
    assert.equal(sent.length, 1)
    const [msg, opts] = sent[0]
    assert.deepEqual(opts, { triggerTurn: true, deliverAs: "steer" })
    assert.equal(msg.customType, "a2a-msg")
    assert.match(msg.content, /^\[message from @cld-lead · w1:p3\]\nrebase now\nthen test\n\n> To reply, use the send_message tool with to: "cld-lead"\./)

    // renderer: compact row, full text when expanded
    const theme = { fg: (_c: string, t: string) => t, bg: (_c: string, t: string) => t }
    const draw = (expanded: boolean) => renderers["a2a-msg"](msg, { expanded, outputPad: 0 }, theme).render(80).map((l: string) => l.trimEnd()).filter(Boolean)
    assert.deepEqual(draw(false), ["↘ @cld-lead: rebase now…"])
    assert.deepEqual(draw(true), ["↘ @cld-lead · w1:p3", "rebase now", "then test"])

    // rename rewrites the record; shutdown removes it and the socket
    rename("pi-two")
    handlers.session_info_changed({ name: "pi-two" }, ctx)
    assert.equal(JSON.parse(fs.readFileSync(own.record, "utf8")).session, "pi-two")
    handlers.session_shutdown({ reason: "quit" }, ctx)
    assert.equal(fs.existsSync(own.record) || fs.existsSync(own.sock), false)
  } finally {
    handlers.session_shutdown?.({ reason: "quit" })
    lead.close()
    files.close()
    delete process.env.A2A_MSG_OWNER
  }
})
