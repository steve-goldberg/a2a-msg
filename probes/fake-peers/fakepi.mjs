// Stand-in for the Pi extension: registry file + Unix-socket inbox; optional send.
import http from "node:http"
import fs from "node:fs"
const DIR = "/tmp/hdr-peers"
const [pane, session = "", sendTo, sendText] = process.argv.slice(2)
const safe = s => s.replace(/[^A-Za-z0-9_-]/g, "_")
const sock = `${DIR}/${safe(pane)}.sock`
try { fs.unlinkSync(sock) } catch {}
http.createServer((req, res) => {
  if (req.method === "GET") return res.end("ok")
  let body = ""; req.on("data", c => (body += c))
  req.on("end", () => { console.log("RECEIVED", body); res.end("ok") })
}).listen(sock, () => {
  fs.writeFileSync(`${DIR}/${safe(pane)}.json`, JSON.stringify({ kind: "pi", pane, session, sock }))
  if (!sendTo) return
  const rec = JSON.parse(fs.readFileSync(`${DIR}/${safe(sendTo)}.json`, "utf8"))
  const req = http.request({ socketPath: rec.sock, path: "/msg", method: "POST" }, r => console.log("SENT", r.statusCode))
  req.end(JSON.stringify({ from: { kind: "pi", pane, name: session || pane }, text: sendText }))
})
process.on("SIGTERM", () => { try { fs.unlinkSync(`${DIR}/${safe(pane)}.json`); fs.unlinkSync(sock) } catch {}; process.exit(0) })
