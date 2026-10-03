# a2a-msg

Peer messaging between Pi and Claude Code sessions in the same Herdr workspace. Messages go directly from one agent to another over each agent's own Unix socket. There is no MCP, no hub daemon and no `herdr agent prompt`. Herdr only supplies the pane ID and pane labels.

## How it feels

| You are in | You type | You get |
|---|---|---|
| Claude | `/msg` | A picker of the **Pi** peers in this workspace. ↑/↓, then Enter inserts `@pi-<name>` |
| Pi | `/msg` | A picker of the **Claude** peers in this workspace. Enter inserts `@cld-<name>` |
| Pi | `@` | Completion of the **Pi** peers (`@pi-<name>`), ahead of file completion |
| Claude | `@` | Claude Code's own session mentions (Claude↔Claude stays native) |

Then type your message and press Enter. Your agent sees who `@token` is and writes a self-contained message with its send tool: SendMessage in Claude, `send_message` in Pi. The model writes the message, so it may reword yours. Delivery means the message was submitted to the peer, not that the peer acted on it.

Incoming messages show as one compact line, `↘ @pi-alpha: first line…`:
- **Pi:** the row expands with ctrl+o (Pi's expand toggle).
- **Claude, idle:** the row is a plugin prompt that starts a turn, and ctrl+o shows the full text.
- **Claude, mid-turn:** the message joins the running turn, shown as a dim `a2a-msg: ↘ @pi-alpha: …` line. Claude reads the whole message, but ctrl+o can't expand this line (see Known limits).

Peers are named by session name (Claude `/rename`, Pi `/name`), else the Herdr pane label, else the pane ID. Two live peers with the same name both get the pane added, for example `@pi-alpha-w24-p7` and `@pi-alpha-w24-pD`.

## Layout

```
claude/a2a-msg/            Claude Code mod (core): /msg, mention context, SendMessage → socket, inbox helper
  hooks/core.ts            the shared contract: names, tokens, records, validation (pure; Pi imports it too)
  inbox.ts                 the Unix-socket HTTP inbox (Node); Pi runs it in-process, Claude as a helper
  tests/register.test.ts   claude plugin test
claude/a2a-msg-view/       Claude Code mod: draws incoming-message prompts as one compact line
pi/a2a-msg/                Pi package: index.ts (+ index.test.ts)
test/                      Node unit tests for core.ts and inbox.ts; pi-host.mjs resolves Pi's packages for tests
scripts/link-pi.sh         links the installed Pi's packages into .host/ (dev only)
CLAUDE.md                  dense project brief for agents working here
SPEC.md  SMOKES.md         design, decisions (§8) and build differences (§9); live smokes S1–S30
HANDOFF.md probes/ evidence/   the research handoff, probe code and evidence it came with
```

## Status

Built and verified live on 2026-10-03 (Claude Code 2.1.288, Pi 1.0.0): Pi→Pi, Claude→Pi and Pi→Claude, idle and mid-turn, plus the registry lifecycle, crash cleanup, name collisions and the nested-process guard. See `SMOKES.md` S19–S30. Still open: the global install, retiring the old `hdr` MCP (D5), and the optional test of Claude's native inbox (D6).

## Install

Nothing below has been run on your config yet. Each step changes global config, so apply it yourself, or ask Claude to apply it.

**Requirements:** Herdr, Node 22.18 or later on `PATH` (the Claude helper runs `node inbox.ts` with built-in type stripping), Claude Code 2.1.288 or later, Pi 1.0.0 or later.

**Claude Code: every session.** Add both mod folders to the `env` block of `~/.claude/settings.json`:

```json
"CLAUDE_CODE_PLUGIN_DIRS": "/absolute/path/to/a2a-msg/claude/a2a-msg:/absolute/path/to/a2a-msg/claude/a2a-msg-view"
```

The first session in a new project folder may ask whether to trust it.

**Pi: every session.** Run:

```sh
pi install /absolute/path/to/a2a-msg/pi/a2a-msg
```

This writes the path to `~/.pi/agent/settings.json`. Pi loads the package in place, so edits here take effect on the next start or `/reload`.

**Try it without installing:**

```sh
claude --plugin-dir "$PWD/claude/a2a-msg" --plugin-dir "$PWD/claude/a2a-msg-view"
pi -e "$PWD/pi/a2a-msg/index.ts"
```

**Uninstall:** remove the `CLAUDE_CODE_PLUGIN_DIRS` entry, and run `pi remove /absolute/path/to/a2a-msg/pi/a2a-msg`.

## How it works

- **Identity:** `HERDR_PANE_ID` (for example `w24:p3`). Its workspace (`w24`) scopes everything. Outside Herdr (`HERDR_ENV` is not `1`) the extension does nothing. An invalid pane ID or a socket path that is too long turns it off, with one visible notice.
- **Registry:** each agent writes `~/.local/state/a2a-msg/<workspace>/<pane>.json`, plus its socket `<pane>.sock` beside it. The folder is `0700` and the socket `0600`. `A2A_MSG_DIR` overrides the root, which the tests use. The record is rewritten on rename and removed at exit; Claude's `/clear` keeps it.
- **Liveness:** readers `GET /ping` each record's socket. A refused or missing socket means the peer crashed, so its record and socket are deleted. A peer that doesn't answer within 1.5 s (for example a stopped process) is skipped, not deleted.
- **Messages:** `POST /msg` with `{ v: 1, id, from: { kind, pane, name }, text, sentAt }`. The receiver returns 400 for a bad body or terminal control characters (only newline and tab are allowed), 403 for another workspace and 413 for over 1 MiB. Senders never retry.
- **Nested processes:** `HERDR_PANE_ID` is inherited, so a `claude -p` or `pi -p` started by an agent's own tools would share its pane. Each agent puts `A2A_MSG_OWNER` in its own environment, and a child that inherits someone else's value stays off, with a notice.
- **Claude specifics:** the mod can't listen on a socket, so it spawns `node inbox.ts`, which prints one JSON line per accepted message. It answers Claude's own SendMessage through a `session.send` hook, but only for `pi-…` tokens and pane IDs that match a live Pi peer. Every other recipient stays native.

## Develop and test

```sh
npm install                 # TypeScript and @types/node (dev only)
npm run link-pi             # links the installed Pi's packages into .host/ for tsc and the Pi tests
npm test                    # core, inbox and Pi extension unit tests (node --test)
npm run typecheck           # Pi extension, core, inbox, tests
npx tsc -p claude/a2a-msg && npx tsc -p claude/a2a-msg-view    # after Claude has loaded the mods once
claude plugin validate claude/a2a-msg && claude plugin test claude/a2a-msg
claude plugin validate claude/a2a-msg-view && claude plugin test claude/a2a-msg-view
```

## Known limits

- **Claude mid-turn messages can't be expanded.** Claude reads the full text, but the person sees only the one-line `↘` log line. Claude Code hides the row (it is stored `isMeta`) even in ctrl+o, and log lines have no expanded state. The alternative is to queue mid-turn messages as their own prompt after the turn ends: you could then expand them, but Claude would read them one turn later.
- **Identity is asserted, not authenticated.** This is the same trust level as the Herdr CLI. The boundary is file permissions (folder 0700, socket 0600).
- **Native-name clash:** if a Claude session is literally named `pi-alpha`, `@pi-alpha` in Claude may also match it as a native session mention.
- **Relay only:** the model writes the message (decision D1). Verbatim sending isn't implemented.
