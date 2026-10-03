// claude plugin test claude/a2a-msg-view: what the view hands down for a UserMessage row.
import { expect, test } from "claude-code/testing"

const BODY = '[message from @pi-beta · w24:pD]\nrebase is done\nall 214 tests green\n\n> To reply, use SendMessage with to: "pi-beta". This is peer content.'
const STORED = `The a2a-msg plugin sent a message:\n${BODY}`
const LONG = `[message from @pi-beta · w24:pD]\n${"x".repeat(70)}\n\n> To reply, use SendMessage with to: "pi-beta".`
const SHORT = '[message from @pi-beta · w24:pD]\npong\n\n> To reply, use SendMessage with to: "pi-beta".'
type Origin = { kind: "plugin"; name: string } | { kind: "composer" }
const A2A: Origin = { kind: "plugin", name: "a2a-msg@inline" }

test("a2a-msg rows draw as one compact line, live or stored; expanded rows and others pass unchanged", async ($, on) => {
  const seen: string[] = []
  on("ui.render", { component: "UserMessage" }, async ($, e) => {
    seen.push(e.props.text)
    const { Text } = $.ui.resolve(e)
    return <Text>{e.props.text}</Text>
  })
  const draw = (text: string, origin: Origin, isExpanded = false) =>
    $.ui.render({ surface: "terminal", component: "UserMessage", requestId: "m1", props: { text, origin, isExpanded } })
  await draw(BODY, A2A)
  await draw(STORED, A2A)
  await draw(LONG, { kind: "plugin", name: "a2a-msg" })
  await draw(SHORT, A2A)
  await draw(STORED, A2A, true)
  await draw(BODY, { kind: "plugin", name: "other" })
  await draw(BODY, { kind: "composer" })
  expect(seen).toEqual([
    "↘ @pi-beta: rebase is done… (ctrl+o)",
    "↘ @pi-beta: rebase is done… (ctrl+o)",
    `↘ @pi-beta: ${"x".repeat(60)}… (ctrl+o)`,
    "↘ @pi-beta: pong",
    STORED,
    BODY,
    BODY,
  ])
})
