// The a2a-msg inbox: HTTP/1.1 on this agent's Unix socket (SPEC.md §3.4). Node only.
// Pi calls listen() in-process. The Claude mod runs this file as its helper:
//   node inbox.ts <sock> <kind> <pane>
// which prints {"ready":true} once listening, then one JSON line per accepted message.
import fs from "node:fs"
import http from "node:http"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { MAX_BODY, parseInbound, pong, workspaceOf, type Kind, type Message } from "./hooks/core.ts"

/** Listens on `sock` (folder 0700, socket 0600); `deliver` runs for each valid message before its 200. */
export function listen(sock: string, kind: Kind, pane: string, deliver: (m: Message) => void): Promise<http.Server> {
  const dir = path.dirname(sock)
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  fs.chmodSync(dir, 0o700)
  fs.rmSync(sock, { force: true })
  const workspace = workspaceOf(pane)
  const server = http.createServer((req, res) => {
    const reply = (status: number, body: string) => res.writeHead(status, { "content-type": "application/json" }).end(body)
    if (req.method === "GET" && req.url === "/ping") return reply(200, pong(kind, pane))
    if (req.method !== "POST" || req.url !== "/msg") return reply(404, JSON.stringify({ ok: false, error: "not found" }))
    const chunks: Buffer[] = []
    let size = 0
    req.on("data", (chunk: Buffer) => { size += chunk.length; if (size <= MAX_BODY) chunks.push(chunk) })
    req.on("end", () => {
      const r = size > MAX_BODY ? { status: 413 as const, error: `body over ${MAX_BODY} bytes` } : parseInbound(Buffer.concat(chunks).toString("utf8"), workspace)
      if (r.status !== 200) return reply(r.status, JSON.stringify({ ok: false, error: r.error }))
      deliver(r.message)
      reply(200, JSON.stringify({ ok: true }))
    })
  })
  return new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(sock, () => { fs.chmodSync(sock, 0o600); resolve(server) })
  })
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [sock, kind, pane] = process.argv.slice(2)
  if (!sock || (kind !== "pi" && kind !== "claude") || !pane) {
    process.stderr.write("usage: node inbox.ts <sock> <pi|claude> <pane>\n")
    process.exit(2)
  }
  listen(sock, kind, pane, m => process.stdout.write(JSON.stringify(m) + "\n")).then(
    () => process.stdout.write(JSON.stringify({ ready: true }) + "\n"),
    (err: Error) => { process.stderr.write(`a2a-msg inbox: ${err.message}\n`); process.exit(1) })
}
