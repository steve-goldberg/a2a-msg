// inbox.ts tests over a real Unix socket in a temp folder: the helper process (Claude) and listen() (Pi).
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import fs from "node:fs"
import http from "node:http"
import { after, test } from "node:test"
import { messageBody, MAX_BODY, paths } from "../claude/a2a-msg/hooks/core.ts"
import { listen } from "../claude/a2a-msg/inbox.ts"

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
    child.kill()
  }
})

test("helper: bad arguments exit 2", async () => {
  const child = spawn("node", [INBOX, "/tmp/x.sock", "cld", "w1:p1"], { stdio: "ignore" })
  assert.equal(await new Promise(r => child.on("exit", r)), 2)
})

test("listen(): in-process delivery, then a stale socket file is replaced on restart", async () => {
  const { sock } = paths(ROOT, "w1:p4")
  const got: string[] = []
  const first = await listen(sock, "pi", "w1:p4", m => got.push(m.text))
  assert.equal((await request(sock, "POST", "/msg", messageBody(from, "one", "a"))).status, 200)
  first.close()
  fs.writeFileSync(sock, "") // what a crash can leave behind
  const second = await listen(sock, "pi", "w1:p4", m => got.push(m.text))
  assert.equal((await request(sock, "POST", "/msg", messageBody(from, "two", "b"))).status, 200)
  second.close()
  assert.deepEqual(got, ["one", "two"])
})
