const [hub, pane, kind = "cld", name = pane, sendTo, sendText] = process.argv.slice(2)
const ws = new WebSocket(`${hub.replace(/^http/, "ws")}/ws?pane=${encodeURIComponent(pane)}&kind=${kind}&name=${name}`)
ws.onmessage = ev => process.stdout.write(String(ev.data) + "\n")
ws.onopen = () => { if (sendTo) setTimeout(() => ws.send(JSON.stringify({ target: sendTo, message: sendText })), 300) }
ws.onclose = () => process.exit(0)
