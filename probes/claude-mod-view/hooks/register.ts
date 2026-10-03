import type { Register } from "claude-code"
const MARK = "[hdr message from "
export const register: Register = on => {
  on("ui.render", { component: "UserMessage" }, async ($, e, next) => {
    const at = e.props.text.indexOf(MARK)
    $.ui.log(`hdr-view row: origin=${JSON.stringify(e.props.origin)} expanded=${e.props.isExpanded} at=${at}`, { to: "debug" })
    if (at < 0 || e.props.isExpanded) return next(e)
    const [head, ...body] = e.props.text.slice(at).split("\n")
    const flat = body.join(" ").trim()
    const who = head.slice(MARK.length, head.indexOf(" ("))
    return next({ ...e, props: { ...e.props, text: `↘ ${who}: ${flat.slice(0, 60)}${flat.length > 60 ? "… (ctrl+o)" : ""}` } })
  })
}
