// claude plugin test claude/a2a-msg: the hooks against the engine, with the host answered here
// (the test kit has no env, process, file or socket of its own): one Pi peer "alpha" in workspace w1.
import { expect, mock, test } from "claude-code/testing"
import type { On } from "claude-code"

const PEER = { v: 1, kind: "pi", pane: "w1:p2", workspace: "w1", session: "alpha", sock: "/r/w1/w1_p2.sock", updatedAt: "t" }
const LABELS = JSON.stringify({ result: { panes: [{ pane_id: "w1:p9", label: "lead" }, { pane_id: "w1:p2" }] } })
const START = { cwd: "/work", surface: null, isInteractive: false }
const MODEL = { kind: "model" } as const
const TYPED = { wait: false, origin: { kind: "composer" } } as const

function host(on: On, options: { failPing?: boolean; owner?: string; inheritedOwner?: boolean } = {}) {
  const files: Record<string, string> = { "/r/w1/w1_p2.json": JSON.stringify(PEER) }
  const fetched: { url: string; sock?: string; body?: string }[] = []
  const logs: string[] = []
  const variables: Record<string, string | undefined> = { HERDR_ENV: "1", HERDR_PANE_ID: "w1:p9", HOME: "/home/t", A2A_MSG_DIR: "/r", A2A_MSG_OWNER: options.owner }
  const spawns: string[][] = []
  let written = () => {}
  const recordWritten = new Promise<void>(resolve => (written = resolve))
  on("env.get", async ($, e) => ({ value: variables[e.name] }))
  mock.clock(on)
  on("session.start", async ($, e) => ({ cwd: e.cwd }))
  on("session.end", async ($, e) => ({ sessionId: e.sessionId }))
  // An op's hook answers { value } (or { deny }).
  on("env.set", async ($, e) => { variables[e.name] = e.value; return { value: undefined } })
  on("session.id", async () => ({ value: "session-1" }))
  on("ui.log", async ($, e) => { logs.push(e.text); return { value: undefined } })
  on("ui.toast", async ($, e) => { logs.push(e.text); return { value: undefined } })
  on("command.register", async ($, e) => ({ value: { command: e.name } }))
  on("process.run", async ($, e) => {
    const [cmd] = e.argv
    if (cmd === "rm") for (const file of e.argv.slice(2)) delete files[file]
    return { value: { exitCode: 0, stdout: cmd === "herdr" ? LABELS : e.argv.includes("--identity") ? JSON.stringify({ pid: 1291, inheritedOwner: options.inheritedOwner ?? false }) : "", stderr: "", isStdoutTruncated: false, isStderrTruncated: false } } // find: no transcript, so no session name
  })
  on("process.spawn", async function* ($, e) {
    spawns.push([...e.argv])
    // The real helper publishes its own record before ready (covered over sockets in Node tests).
    files["/r/w1/w1_p9.json"] = JSON.stringify({ ...PEER, kind: "claude", pane: "w1:p9", session: "", sock: "/r/w1/w1_p9.sock" })
    yield { stream: "stdout" as const, text: '{"ready":true}\n' }
    return { value: { code: 0, signal: null } }
  })
  const under = (dir: string) => Object.keys(files).filter(f => f.startsWith(`${dir}/`))
  on("fs.exists", async ($, e) => ({ value: under(e.path).length > 0 }))
  on("fs.list", async ($, e) => ({ value: under(e.path).map(f => ({ name: f.slice(e.path.length + 1), kind: "other" as const, size: 0, mtimeMs: 0, isLink: true })) }))
  on("fs.read", async ($, e) => {
    const text = files[e.path]
    return text === undefined ? { deny: `ENOENT ${e.path}` } : { value: text }
  })
  on("fs.write", async ($, e) => { files[e.path] = e.text; return { value: undefined } })
  on("http.fetch", async ($, e) => {
    fetched.push({ url: e.url, sock: e.init?.socketPath, body: e.init?.body })
    if (options.failPing && e.url.endsWith("/ping")) return { deny: "ENOENT during peer startup" }
    if (e.url.endsWith("/session")) {
      const body = JSON.parse(e.init?.body ?? "{}")
      files["/r/w1/w1_p9.json"] = JSON.stringify({ ...JSON.parse(files["/r/w1/w1_p9.json"] ?? "{}"), session: body.session })
      written()
    }
    const text = e.url.endsWith("/ping") ? JSON.stringify({ v: 1, kind: "pi", pane: "w1:p2" }) : '{"ok":true}'
    return { value: { status: 200, ok: true, headers: {}, text } }
  })
  return { files, fetched, logs, recordWritten, spawns }
}

test("session.send: a Pi token is POSTed to the peer's socket; any other recipient stays native", async ($, on) => {
  const { files, fetched, recordWritten } = host(on)
  const native: string[] = []
  on("session.send", async ($, e) => { native.push(String(e.to)); return { isDelivered: true } })
  await $.session.start(START)

  expect(await $.session.send({ to: "pi-alpha", text: "the build is green", origin: MODEL })).toEqual({ isDelivered: true })
  const post = fetched.find(f => f.url === "http://peer/msg")
  expect(post?.sock).toBe("/r/w1/w1_p2.sock")
  expect(JSON.parse(post?.body ?? "{}")).toMatchObject({ v: 1, from: { kind: "claude", pane: "w1:p9", name: "lead" }, text: "the build is green" })

  expect(await $.session.send({ to: "teammate", text: "hi", origin: MODEL })).toEqual({ isDelivered: true })
  expect(await $.session.send({ to: "pi-gone", text: "hi", origin: MODEL })).toEqual({ isDelivered: true })
  expect(native).toEqual(["teammate", "pi-gone"])
  // Written by the inbox loop once the helper reports ready, after session.start returned.
  await recordWritten
  expect(JSON.parse(files["/r/w1/w1_p9.json"] ?? "{}")).toMatchObject({ v: 1, kind: "claude", pane: "w1:p9", session: "" })
})

test("prompt.submit: a mentioned live Pi peer is described to Claude", async ($, on) => {
  host(on)
  const contexts: (readonly string[] | undefined)[] = []
  on("prompt.submit", async ($, e) => { contexts.push(e.context); return { text: e.text, context: e.context } })
  await $.session.start(START)
  await $.prompt.submit({ text: "@pi-alpha please rebase on main", ...TYPED })
  await $.prompt.submit({ text: "no mention here", ...TYPED })
  expect(contexts[0]?.[0]).toMatch(/^@pi-alpha is a Pi session in this Herdr workspace \(pane w1:p2\)\. To message it, use SendMessage with to: "pi-alpha"\./)
  expect(contexts[1]).toBeUndefined()
})

test("resume and clear keep the process inbox registered", async ($, on) => {
  const { files, recordWritten } = host(on)
  await $.session.start(START)
  await recordWritten
  for (const reason of ["resume", "clear"] as const) {
    await $.session.end({ reason, sessionId: "session-1", resume: { id: "session-1" } })
    expect(files["/r/w1/w1_p9.json"]).toBeDefined()
  }
})

test("a failed probe of an unlabeled but present pane preserves its registration", async ($, on) => {
  const { files } = host(on, { failPing: true })
  const native: string[] = []
  on("session.send", async ($, e) => { native.push(e.to); return { isDelivered: true } })
  await $.session.start(START)
  await $.session.send({ to: "pi-alpha", text: "hello", origin: MODEL })
  expect(native).toEqual(["pi-alpha"])
  expect(files["/r/w1/w1_p2.json"]).toBe(JSON.stringify(PEER))
})

test("reload after conversation state is lost does not reject the original process owner", async ($, on) => {
  const { files, logs, spawns, recordWritten } = host(on, { owner: "legacy-owning-process-uuid" })
  // /resume and /clear replace session-scoped state, but env.set survives in the process.
  on("state.get", { plugin: "a2a-msg", key: "owner" }, async () => ({ value: { value: undefined, version: 0 } }))
  await $.session.start(START)
  expect(spawns.length).toBe(1)
  await recordWritten
  await $.session.end({ reason: "resume", sessionId: "session-1", resume: { id: "session-1" } })
  await $.session.start(START) // module reload under the new conversation
  expect(spawns.length).toBe(2)
  expect(files["/r/w1/w1_p9.json"]).toBeDefined()
  expect(logs.some(line => line.includes("belongs to the agent"))).toBe(false)
})

test("an inherited owner still disables a genuinely nested Claude process", async ($, on) => {
  const { files, logs, spawns } = host(on, { owner: "parent-owner-uuid", inheritedOwner: true })
  await $.session.start(START)
  expect(spawns.length).toBe(0)
  expect(files["/r/w1/w1_p9.json"]).toBeUndefined()
  expect(logs.some(line => line.includes("belongs to the agent"))).toBe(true)
})
