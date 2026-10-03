import http from "node:http"
import fs from "node:fs"
const sock = process.argv[2]
try { fs.unlinkSync(sock) } catch {}
http.createServer((req, res) => {
  if (req.method === "GET") return res.end("ok")
  let body = ""
  req.on("data", c => (body += c))
  req.on("end", () => { process.stdout.write(JSON.stringify(JSON.parse(body)) + "\n"); res.end("ok") })
}).listen(sock)
