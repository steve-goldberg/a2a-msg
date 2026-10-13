# Handoff: build a2a-msg (Claude mod + Pi extension)

> **Built 2026-10-03** by `a2a-msg-build1`. See `README.md` (use, install, tests), `SPEC.md` §8–§9 (decisions, how the build differs) and `SMOKES.md` S19–S30 (live checks). Decisions since: install deferred, D5 keep `hdr` MCP, D6 skipped (SPEC.md §8).

**From:** session `claudemods` (hdr-mcp research), 2026-10-03.
**To:** `a2a-msg-build1`.
**Repo:** the a2a-msg checkout. At the time of this handoff, it was not yet a Git repository.

## Read in this order
1. This file.
2. `SPEC.md`: the full spec for the Claude mod and the Pi extension, the shared registry and protocol, and the open decisions.
3. `SMOKES.md`: every smoke and test already run (S1–S18), with commands, results and pitfalls, plus a "Not yet tested" list.
4. `probes/README.md`: the working throwaway code those smokes used; `probes/claude-mod-msg` and `probes/pi-extension-msg` are the starting points.
5. `evidence/`: outputs (`outputs/*.out`) and plugin-only extracts of the Claude debug logs (`logs/*.plugin-lines.log`). The raw debug logs were **not** copied. The auto-mode classifier blocked checking one line for credentials, so they stay in `/tmp/hdr-hub` and will be gone after a reboot.

## The goal in one paragraph
Peer messaging between Pi and Claude Code sessions in the same Herdr workspace: Pi→Pi, Pi→Claude and Claude→Pi. It should feel native and identical on both sides. Typing `/msg` opens a popup of peers, named by session name, then Herdr pane label, then pane ID. ↑/↓ and Enter insert `@pi-name` / `@cld-name`; the user types the message and presses Enter. The agent sends it **directly** to the peer's Unix socket. Incoming messages show as a compact line that expands. There is no MCP, no hub daemon and no `herdr agent prompt`. Herdr only supplies the pane ID (env) and pane labels (read-only).

## What is already proven (don't re-research)
- Claude mods can do every piece: the `/msg` dialog picker (`$.ui.open` + `Select`), inserting the mention (`$.prompt.fill`), giving context on submit, serving Claude's **own SendMessage** for peers (`session.send`), delivering through `$.http.fetch({ socketPath })`, receiving through a `$.process.spawn` Node helper, idle wake (`$.prompt.submit`), mid-turn delivery (`$.session.append` + `$.ui.log`), and compact expandable rows (a second plugin).
- Pi: `ctx.ui.select`, `pasteToEditor`, an in-process socket server, `pi.sendMessage(..., { triggerTurn, deliverAs })`, `getSessionName` / `session_info_changed` / `session_shutdown`. A real Pi received a Claude message and replied "pong".
- The registry lifecycle (start, rename, `/clear`, exit, quit, crash filtering) was verified with a real Claude and a real Pi (S17, S18).
- Mods **cannot** add rows to Claude's `@` typeahead or style the prompt, and arrows/Tab never reach `prompt.edit`. That's why `/msg` is a dialog.

## Ask the user before building these parts (SPEC.md §8)
- **D1:** relay (the model writes the message; tested) vs verbatim (send exactly what was typed) vs both.
- **D2:** should Claude's `/msg` list Claude peers too, or leave those to native `@session`?
- **D3:** Pi-only `@` autocomplete, on or off?
- **D4:** registry location.
- **D5:** retiring the old `hdr` MCP and Pi extension changes the user's config.
- **D6:** the optional native Claude inbox spike, which needs the user watching the pane.

## Suggested build order (each step ends with the listed check)
1. **`core.ts` (pure, shared):** names (`clean`, no double prefix), tokens and collisions, mention regex, record schema/parse, message validation, socket path check. Check: unit tests pass.
2. **Pi extension:** registry + inbox server + `/msg` + `before_agent_start` context + the `send_message` tool + the message renderer. Check: two real Pis in your workspace message each other both ways, idle and mid-stream.
3. **Claude core mod:** port `probes/claude-mod-msg` to the spec: real registry folder, workspace scope, stale-record deletion, preselected `Select` value, record v1, `inbox.mjs` validation, the S2 testing approach. Check: `claude plugin validate`, `tsc -p`, and live S14/S15/S17/S18 against real Pi.
4. **Claude view plugin:** port `probes/claude-mod-view` with the origin-name match. Check: compact row, ctrl+o full text.
5. **Untested items** from `SMOKES.md` (Esc-interrupted turns, `isMeta` in ctrl+o, collisions, `/clear` then rename, Pi streaming delivery).
6. **Install docs and steps** for both sides. Show the user before changing any global config (`CLAUDE_CODE_PLUGIN_DIRS`, Pi global packages).

## Hard rules for this work
- **Own Herdr workspace only.** Always run `herdr tab create --workspace "${HERDR_PANE_ID%%:*}" …` and `herdr pane list --workspace …`. Never touch, read or reuse other workspaces' panes or labels. The user flagged this twice; tabs once landed in another workspace.
- **User's global rules** (`~/.claude/CLAUDE.md`): fail fast, with no silent fallbacks; read files before changing them; check APIs exist (grep the types); run the code; keep it simple; no secrets in logs.
- **Never read `~/.claude/sessions/*`**, and don't read a Claude pane right after posting into its native inbox socket. The classifier blocks both as credential exploration.
- **The mods API is early access.** The running build's `types/claude-code.d.ts`, named by the `plugin-authoring` skill, is the authority. Load that skill first. Its dev-mods folder triggers a one-time "Enable hot reloading?" question for the user; `--plugin-dir` avoids it.
- **Clean up** every test tab, process and temp folder you create.

## Environment facts
Claude Code 2.1.288, Pi 1.0.0 (`/opt/homebrew/bin/pi`, provider openai-codex), Node 26.10.0 (global `WebSocket`, `--experimental-strip-types`), Bun 1.3.12, macOS, Herdr CLI with JSON output (`herdr pane list|get|read|send-text|send-keys|run|process-info --pane`). The `timeout` on PATH is broken; use background jobs and `kill`.
