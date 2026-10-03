// One shared listener. Names: session name, then Herdr pane label (read-only lookup), then pane ID.
type Peer = { pane: string; kind: string; session: string; label: string }
const socks = new Map<string, { ws: any; peer: Peer }>()
const shown = (p: Peer) => ({ pane: p.pane, kind: p.kind, name: p.session || p.label || p.pane })
async function label(pane: string) {
  try {
    const out = await new Response(Bun.spawn(["herdr", "pane", "get", pane]).stdout).text()
    const j = JSON.parse(out); return String(j.result?.pane?.label ?? j.result?.label ?? "")
  } catch { return "" }
}
const broadcast = () => { for (const s of socks.values()) s.ws.send(JSON.stringify({ type: "peers", peers: [...socks.values()].filter(o => o !== s).map(o => shown(o.peer)) })) }
Bun.serve({
  hostname: "127.0.0.1", port: Number(process.argv[2] ?? 8766),
  async fetch(req, server) {
    const u = new URL(req.url)
    if (u.pathname === "/ws") {
      const q = u.searchParams
      const peer = { pane: q.get("pane")!, kind: q.get("kind")!, session: q.get("name") ?? "", label: await label(q.get("pane")!) }
      return server.upgrade(req, { data: peer }) ? undefined : new Response("no", { status: 400 })
    }
    if (req.method !== "POST") return new Response("not found", { status: 404 })
    const body = await req.json()
    if (u.pathname === "/hello") { const s = socks.get(body.pane); if (!s) return new Response("unknown pane", { status: 404 }); s.peer.session = body.name ?? ""; broadcast(); return new Response("ok") }
    if (u.pathname === "/send") {
      const dest = socks.get(body.target); const src = socks.get(body.from)
      if (!dest) return new Response("unknown target", { status: 404 })
      dest.ws.send(JSON.stringify({ type: "message", from: src ? shown(src.peer) : { pane: body.from, kind: "?", name: body.from }, text: body.message }))
      return new Response("ok")
    }
    return new Response("not found", { status: 404 })
  },
  websocket: {
    open(ws) { socks.set(ws.data.pane, { ws, peer: ws.data }); broadcast() },
    message(ws, raw) { const { target, message } = JSON.parse(String(raw)); socks.get(target)?.ws.send(JSON.stringify({ type: "message", from: shown(ws.data), text: message })) },
    close(ws) { socks.delete(ws.data.pane); broadcast() },
  },
})
console.log("hub up")
