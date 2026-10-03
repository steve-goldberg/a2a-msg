// a2a-msg-view: a2a-msg's incoming-message prompts drawn as `↘ @token: first line… (ctrl+o)`.
// Its own plugin because the plugin that submits a row cannot restyle it (the re-entry rule).
import type { Register } from "claude-code"

// The head and footer core.ts inboundText writes (a stored row adds the engine's own line before
// the head: "The a2a-msg plugin sent a message:"); the compact line matches core.ts compactLine.
const HEAD = /(?:^|\n)\[message from @(\S+) · [^\]\n]+\]\n/
const FOOTER = "\n\n> To reply, "
const MAX = 60

export const register: Register = on => {
  on("ui.render", { component: "UserMessage" }, async ($, e, next) => {
    const { origin, text, isExpanded } = e.props
    const ours = origin.kind === "plugin" && (origin.name === "a2a-msg" || origin.name.startsWith("a2a-msg@"))
    const head = ours && !isExpanded ? text.match(HEAD) : null
    if (!head) return next(e)
    const end = text.lastIndexOf(FOOTER)
    const start = (head.index ?? 0) + head[0].length
    const lines = text.slice(start, end > start ? end : undefined).split("\n").map(l => l.trim()).filter(Boolean)
    const first = Array.from(lines[0] ?? "")
    const more = first.length > MAX || lines.length > 1
    return next({ ...e, props: { ...e.props, text: `↘ @${head[1]}: ${first.slice(0, MAX).join("")}${more ? "… (ctrl+o)" : ""}` } })
  })
}
