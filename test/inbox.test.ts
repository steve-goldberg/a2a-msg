// inbox.ts tests over a real Unix socket in a temp folder: the helper process (Claude) and listen() (Pi).
import assert from "node:assert/strict"
import { spawn, spawnSync } from "node:child_process"
import fs from "node:fs"
import http from "node:http"
import { after, test } from "node:test"
import { messageBody, MAX_BODY, parseRecord, paths } from "../claude/a2a-msg/hooks/core.ts"
import { listen, reap } from "../claude/a2a-msg/inbox.ts"

const ROOT = fs.mkdtempSync("/tmp/a2a-inbox-")
after(() => fs.rmSync(ROOT, { recursive: true, force: true }))
const INBOX = new URL("../claude/a2a-msg/inbox.ts", import.meta.url).pathname

function request(sock: string, method: string, url: string, body?: string): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath: sock, method, path: url, agent: false, headers: { "content-type": "application/json" } }, res => {
      let text = ""
      res.on("data", c => (text += c))
      res.on("end", () => resolve({ status: res.statusCode!, text }))
    })
    req.on("error", reject)
    req.end(body)
  })
}

const from = { kind: "pi" as const, pane: "w1:p3", name: "alpha" }

test("helper: ready line, ping, valid and invalid messages, file modes", async () => {
  const { sock, dir } = paths(ROOT, "w1:p9")
  const child = spawn("node", [INBOX, sock, "claude", "w1:p9"], { stdio: ["ignore", "pipe", "inherit"] })
  try {
    const lines: string[] = []
    let buf = ""
    let wake = () => {}
    child.stdout.on("data", (chunk: Buffer) => {
      buf += chunk
      for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) { lines.push(buf.slice(0, i)); buf = buf.slice(i + 1) }
      wake()
    })
    const line = async (n: number) => { while (lines.length <= n) await new Promise<void>(r => (wake = r)); return JSON.parse(lines[n]!) }
    assert.deepEqual(await line(0), { ready: true })
    assert.equal(fs.statSync(dir).mode & 0o777, 0o700)
    assert.equal(fs.statSync(sock).mode & 0o777, 0o600)

    assert.deepEqual(await request(sock, "GET", "/ping"), { status: 200, text: '{"v":1,"kind":"claude","pane":"w1:p9"}' })
    assert.deepEqual(await request(sock, "POST", "/msg", messageBody(from, "hello\tthere", "id-1")), { status: 200, text: '{"ok":true}' })
    const got = await line(1)
    assert.deepEqual([got.id, got.from, got.text], ["id-1", from, "hello\tthere"])

    assert.equal((await request(sock, "POST", "/msg", "{nope")).status, 400)
    assert.equal((await request(sock, "POST", "/msg", messageBody({ ...from, pane: "w2:p3" }, "x", "id-2"))).status, 403)
    assert.equal((await request(sock, "POST", "/msg", "x".repeat(MAX_BODY + 10))).status, 413)
    assert.equal((await request(sock, "GET", "/other")).status, 404)
    assert.equal(lines.length, 2, "rejected messages print nothing")
  } finally {
    const exited = new Promise(resolve => child.once("exit", resolve))
    child.kill()
    await exited
  }
})

test("host identity distinguishes a process's runtime owner from an inherited owner", () => {
  for (const inheritedOwner of [false, true]) {
    const env = { ...process.env }
    if (inheritedOwner) env.A2A_MSG_OWNER = "parent-owner"
    else delete env.A2A_MSG_OWNER
    const wrapper = `const {spawnSync}=require('node:child_process');process.env.A2A_MSG_OWNER='runtime-owner';const r=spawnSync(process.execPath,[${JSON.stringify(INBOX)},'--identity'],{encoding:'utf8'});if(r.status!==0)process.exit(1);const info=JSON.parse(r.stdout);console.log(JSON.stringify({...info,sameHost:info.pid===process.pid}));`
    const r = spawnSync(process.execPath, ["-e", wrapper], { env, encoding: "utf8" })
    assert.equal(r.status, 0, r.stderr)
    const info = JSON.parse(r.stdout)
    assert.equal(info.sameHost, true)
    assert.equal(info.inheritedOwner, inheritedOwner)
  }
})

test("helper: bad arguments exit 2", async () => {
  const child = spawn("node", [INBOX, "/tmp/x.sock", "cld", "w1:p1"], { stdio: "ignore" })
  assert.equal(await new Promise(r => child.on("exit", r)), 2)
})

test("an old inbox closing cannot unlink the replacement listener", async () => {
  const { sock } = paths(ROOT, "w1:p6")
  const first = await listen(sock, "pi", "w1:p6", () => {})
  const got: string[] = []
  const second = await listen(sock, "pi", "w1:p6", m => got.push(m.text))
  try {
    await first.close()
    assert.equal(fs.existsSync(sock), true, "old close must not remove the new generation's address")
    assert.equal((await request(sock, "POST", "/msg", messageBody(from, "new generation", "replacement"))).status, 200)
    assert.deepEqual(got, ["new generation"])
  } finally {
    await first.close()
    await second.close()
  }
})

test("repair restores lost pane aliases, records and an unlinked underlying listener", async () => {
  const p = paths(ROOT, "w1:p7")
  const got: string[] = []
  const inbox = await listen(p.sock, "pi", "w1:p7", m => got.push(m.text), { record: p.record, session: "survivor" })
  try {
    fs.unlinkSync(p.sock)
    fs.unlinkSync(p.record)
    await inbox.repair()
    assert.equal(JSON.parse(fs.readFileSync(p.record, "utf8")).session, "survivor")
    assert.equal((await request(p.sock, "GET", "/ping")).status, 200)

    // Losing the actual listener pathname requires a rebind, not just a registry rewrite.
    fs.unlinkSync(`${p.dir}/${fs.readlinkSync(p.sock)}`)
    fs.unlinkSync(`${p.dir}/${fs.readlinkSync(p.record)}`)
    await inbox.repair()
    assert.equal(JSON.parse(fs.readFileSync(p.record, "utf8")).session, "survivor")
    assert.equal((await request(p.sock, "POST", "/msg", messageBody(from, "after repair", "repair"))).status, 200)
    assert.deepEqual(got, ["after repair"])
  } finally { await inbox.close() }
})

test("a superseded inbox's repair and rename cannot overwrite its replacement", async () => {
  const p = paths(ROOT, "w1:p8")
  const first = await listen(p.sock, "pi", "w1:p8", () => {}, { record: p.record, session: "old" })
  const second = await listen(p.sock, "pi", "w1:p8", () => {}, { record: p.record, session: "new" })
  try {
    assert.throws(() => first.setSession("wrong"), /superseded/)
    await first.repair()
    assert.equal(JSON.parse(fs.readFileSync(p.record, "utf8")).session, "new")
    assert.equal((await request(p.sock, "GET", "/ping")).status, 200)
  } finally {
    await first.close()
    await second.close()
  }
})

test("helper automatically repairs lost discovery paths without restarting Claude", { timeout: 5000 }, async () => {
  const p = paths(ROOT, "w1:pA")
  const child = spawn("node", [INBOX, p.sock, "claude", "w1:pA", "owner-a"], { stdio: ["ignore", "pipe", "inherit"] })
  const exited = new Promise<number | null>(resolve => child.once("exit", resolve))
  let output = ""
  const ready = new Promise<void>(resolve => child.stdout.on("data", chunk => {
    output += chunk
    if (output.includes('{"ready":true}\n')) resolve()
  }))
  try {
    await ready
    const update = JSON.stringify({ owner: "owner-a", session: "still here" })
    assert.equal((await request(p.sock, "POST", "/session", update)).status, 200)
    fs.unlinkSync(p.sock)
    fs.unlinkSync(p.record)
    // Poll only liveness, never message delivery. The helper's real maintenance timer does the repair.
    const deadline = Date.now() + 2500
    while (!fs.existsSync(p.sock) || !fs.existsSync(p.record)) {
      assert.ok(Date.now() < deadline, "helper must restore its registration automatically")
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    assert.equal(JSON.parse(fs.readFileSync(p.record, "utf8")).session, "still here")
    assert.equal((await request(p.sock, "POST", "/msg", messageBody(from, "recovered", "auto-repair"))).status, 200)
    assert.equal((await request(p.sock, "POST", "/session", JSON.stringify({ owner: "old-owner", session: "wrong" }))).status, 403)
    assert.equal((await request(p.sock, "POST", "/close", JSON.stringify({ owner: "old-owner" }))).status, 403)
    assert.equal(JSON.parse(fs.readFileSync(p.record, "utf8")).session, "still here")
    assert.equal((await request(p.sock, "POST", "/close", JSON.stringify({ owner: "owner-a" }))).status, 200)
    assert.equal(await exited, 0)
    assert.match(output, /"text":"recovered"/)
    assert.equal(fs.existsSync(p.sock) || fs.existsSync(p.record), false)
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill()
    await exited
  }
})

test("crash cleanup reaps only a proven dead owner's private generation", { timeout: 5000 }, async () => {
  const p = paths(ROOT, "w1:pB")
  const child = spawn("node", [INBOX, p.sock, "claude", "w1:pB"], { stdio: ["ignore", "pipe", "inherit"] })
  const exited = new Promise(resolve => child.once("exit", resolve))
  try {
    await new Promise<void>(resolve => child.stdout.on("data", chunk => { if (String(chunk).includes('"ready":true')) resolve() }))
    const r = parseRecord(fs.readFileSync(p.record, "utf8"), "w1", ROOT)!
    assert.equal(r.pid, child.pid)
    assert.equal(reap(r), false, "a failed probe alone cannot authorize unlinking a live owner's targets")
    assert.equal(spawnSync(process.execPath, [INBOX, "--reap", ROOT, "w2", JSON.stringify(r)], { encoding: "utf8" }).status, 2, "CLI cleanup is workspace scoped")
    assert.equal((await request(p.sock, "GET", "/ping")).status, 200)
    child.kill("SIGKILL")
    await exited
    assert.equal(reap(r), true)
    assert.equal(fs.existsSync(p.sock) || fs.existsSync(p.record), false)
    // A later generation is unaffected by cleanup of the old snapshot.
    const replacement = await listen(p.sock, "claude", "w1:pB", () => {}, { record: p.record, session: "new" })
    try {
      assert.equal(spawnSync(process.execPath, [INBOX, "--reap", ROOT, "w1", JSON.stringify(r)], { encoding: "utf8" }).status, 0)
      assert.equal((await request(p.sock, "GET", "/ping")).status, 200)
      assert.equal(JSON.parse(fs.readFileSync(p.record, "utf8")).session, "new")
    } finally { await replacement.close() }
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
    await exited
  }
})

test("listen(): in-process delivery, then a stale socket file is replaced on restart", async () => {
  const { sock } = paths(ROOT, "w1:p4")
  const got: string[] = []
  const first = await listen(sock, "pi", "w1:p4", m => got.push(m.text))
  assert.equal((await request(sock, "POST", "/msg", messageBody(from, "one", "a"))).status, 200)
  await first.close()
  fs.rmSync(sock, { force: true })
  fs.writeFileSync(sock, "") // a legacy crash can leave a stale socket pathname
  const second = await listen(sock, "pi", "w1:p4", m => got.push(m.text))
  assert.equal((await request(sock, "POST", "/msg", messageBody(from, "two", "b"))).status, 200)
  await second.close()
  assert.deepEqual(got, ["one", "two"])
})
