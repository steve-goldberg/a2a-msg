// Pi side: same /msg picker, plus the registry record and Unix-socket inbox lifecycle.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import fs from "node:fs";
import http from "node:http";
const DIR = "/tmp/hdr-peers";
const pane = process.env.HERDR_PANE_ID ?? "";
const safe = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, "_");
const rec = `${DIR}/${safe(pane)}.json`, sock = `${DIR}/${safe(pane)}.sock`;
const token = (p: any) => `${p.kind}-${p.session || p.pane}`.replace(/[^A-Za-z0-9._-]/g, "-");
export default function (pi: ExtensionAPI) {
  let server: http.Server | undefined;
  const write = () => fs.writeFileSync(rec, JSON.stringify({ kind: "pi", pane, session: pi.getSessionName() ?? "", sock }));
  const remove = () => { server?.close(); server = undefined; for (const f of [rec, sock]) { try { fs.unlinkSync(f) } catch {} } };
  pi.on("session_start", async () => {
    fs.mkdirSync(DIR, { recursive: true }); remove();
    server = http.createServer((req, res) => {
      if (req.method === "GET") return res.end("ok");
      let body = ""; req.on("data", c => (body += c));
      req.on("end", () => {
        const m = JSON.parse(body);
        pi.sendMessage({ customType: "hdr", content: `[message from @${m.from.kind}-${m.from.name} · ${m.from.pane}]\n${m.text}`, display: true }, { triggerTurn: true, deliverAs: "steer" });
        res.end("ok");
      });
    }).listen(sock, write);
  });
  pi.on("session_info_changed", async () => write());
  pi.on("session_shutdown", async () => remove());
  pi.registerCommand("msg", {
    description: "Message a Pi or Claude peer in this Herdr",
    handler: async (_args, ctx) => {
      const peers = fs.readdirSync(DIR).filter(f => f.endsWith(".json"))
        .map(f => JSON.parse(fs.readFileSync(`${DIR}/${f}`, "utf8"))).filter(p => p.pane !== pane);
      const rows = peers.map(p => `${p.session || p.pane}  ${p.kind === "pi" ? "Pi" : "Claude"} · ${p.pane}`);
      const pick = await ctx.ui.select("Message a peer", rows);
      if (pick !== undefined) ctx.ui.pasteToEditor(`@${token(peers[rows.indexOf(pick)])} `);
    },
  });
}
