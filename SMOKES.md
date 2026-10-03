# Smokes and tests run so far (2026-10-03)

Every smoke below ran live on this machine during the research session `claudemods` (Claude Code 2.1.288, Pi 1.0.0, Node 26.10.0, Bun 1.3.12, Herdr CLI). Fake peers stood in for Pi unless a row says "real Pi". The code is in `probes/`, and the outputs and plugin log extracts are in `evidence/`.

**Status key:** ✅ verified live · ⚠️ verified with a caveat · ❌ did not work · 📄 API- or doc-verified only, never run live.

## Rules for re-running any of these

- **Stay in your own Herdr workspace.** `herdr tab create` with no `--workspace` uses the *focused* workspace, which the user changes while you work. Always pass it explicitly:
  `WS=${HERDR_PANE_ID%%:*}; herdr tab create --workspace "$WS" --cwd <dir> --label <name> --no-focus`
- **Scope pane listings.** Filter `herdr pane list` to your workspace (`--workspace "$WS"`). Never use another workspace's pane IDs or labels, even in throwaway files. The user flagged this twice; S17 and S14 both slipped.
- **Use the `timeout` workaround.** The `timeout` on PATH is a broken Python shim. Use `cmd & PID=$!; sleep N; kill $PID`.
- **Watch the `--allowedTools` flag.** It is variadic, so `claude -p --allowedTools X "prompt"` swallows the prompt. Pipe the prompt on stdin.
- **Drive the TUI through Herdr.** Use `herdr pane send-text <pane> "..."`, `herdr pane send-keys <pane> Enter|down|up|esc|ctrl+u|ctrl+e|ctrl+o`, and `herdr pane read <pane>`.
- **Clear the prompt fully.** `ctrl+u` only kills text *before* the cursor, so use `ctrl+e` then `ctrl+u`.
- **Plugin debugging.** Run Claude with `--debug-file <path>`. Mod `$.ui.log(..., { to: "debug" })` lines appear as `[<plugin>] $.ui.log (to debug): ...`, and engine lines name each `$.http.fetch` and `$.process.run`.
- **Trust prompt.** A new `--plugin-dir` folder triggers Claude's folder-trust prompt. Answer it with `down`, then `Enter`.
- **Never read `~/.claude/sessions/*`** (the auto-mode classifier blocks it: credential exploration). Don't read a pane right after injecting into a Claude inbox socket either; that was blocked once too.

## Smoke index

| # | What | Probe | Result |
|---|---|---|---|
| S1 | Mod API acceptance (`claude plugin validate`) | `probes/claude-mod-hub` | ✅ |
| S2 | `claude plugin test` against real env/process/http | (test deleted) | ❌ test kit has no `env`/`process`/`http`; they must be mocked |
| S3 | Pi↔Pi over one WebSocket hub | `probes/hub` | ✅ |
| S4 | Headless `claude -p` + mod: send tool → hub → Pi; mid-turn inbound | `claude-mod-hub` | ✅ after a result-shape fix |
| S5 | Interactive: `@hdr-` band, space-completion, mention context, idle wake | `claude-mod-hub` | ✅ |
| S6 | Names: pane-ID fallback, `/rename` propagation, Herdr label fallback | `claude-mod-hub`, `hub` | ✅ |
| S7 | Compact inbound row + ctrl+o expand | `claude-mod-view` | ✅ needs a 2nd plugin (re-entry rule) |
| S8 | Mid-turn visibility | `claude-mod-hub` | ⚠️ `session.append` user rows are hidden; a `system` notice did not show; `$.ui.log` is visible |
| S9 | Native session mention look and ranking vs MCP resources | (observation) | ✅ |
| S10 | Post into Claude's native inbox socket from an outside process | (inline python) | ⚠️ delivered; render not observed |
| S11 | Claude's own SendMessage served by a `session.send` hook | `claude-mod-hub` | ✅ |
| S12 | One native `/` command per peer, hidden when the peer leaves | `claude-mod-hub` | ✅ |
| S13 | Custom `$` trigger + which keys reach `prompt.edit` | `claude-mod-hub` | ✅ arrows/Tab never reach it |
| S14 | Hubless `/msg` picker → mention → SendMessage → socket POST | `claude-mod-msg` + `fake-peers` | ✅ |
| S15 | Hubless Pi → Claude (idle) | `claude-mod-msg` + `fake-peers` | ✅ |
| S16 | Real Pi `/msg` picker + paste into editor | `pi-extension-msg` | ✅ |
| S17 | Registry lifecycle, real Claude + real Pi; real delivery Claude → Pi | `claude-mod-msg` + `pi-extension-msg` | ✅ (ran in the wrong workspace) |
| S18 | Crash (`kill -9`) → stale record filtered; picker keyboard capture | `claude-mod-msg` (fork, workspace w24) | ✅ |

---

## S1: mod API acceptance ✅

`claude plugin validate /tmp/hdr-probe` passed. It listed every hook (`session.start`, `tool.call{tool=mcp__hdr-probe__send}`, `prompt.edit`, `prompt.submit`, `ui.render{component=AbovePrompt}`, later `turn.start`, `turn.complete`, `session.send`, `command.run`, `command.describe`) and every call (`$.env.get`, `$.http.fetch`, `$.process.spawn`, `$.process.run`, `$.prompt.submit`, `$.prompt.fill`, `$.session.append`, `$.state.*`, `$.tool.register`, `$.command.register`, `$.ui.*`).

The validator also enforces two rules:
- A helper that takes `$` must be a **top-level function declaration**. A nested `async function sessionName($)` inside `register` was refused: `$ is passed to "sessionName", which is not a function declared at the top of this file`.
- `$.env.get` names must be string literals. The validator lists env reads, for example `env reads: HERDR_PANE_ID`.

## S2: `claude plugin test` ❌ (approach limit)

A `*.test.ts` that relied on real `$.env`, `$.process.spawn` and `$.http.fetch` failed:
- `TypeError: undefined is not an object (evaluating '$.env.set')`: the test's `$` has no `env` noun.
- Then `hdr-probe2's session.start hook was skipped: no implementation for env.get`.

**Lesson:** in `claude plugin test` the bottom of every chain is the test's own `on(...)` hooks. Pure logic needs unit tests, and nouns like `env.get`, `process.*` and `http.fetch` must be implemented in the test with `on(...)`. That last step was never tried; check the `claude-code/testing` declarations first. The test file was deleted, and live smokes were used instead.

## S3: Pi↔Pi over a WebSocket hub ✅ (design later superseded)

- **Setup:** `bun probes/hub/hub.ts 8766`. Clients: `node probes/hub/client.mjs http://127.0.0.1:8766 <pane> <kind> <name> [sendTo text]` (Node 26 has a global `WebSocket`).
- **Result:** alpha received `{"type":"message","from":"w1:p2","text":"hello from beta"}`, and both clients got presence (`peers`) frames.

## S4: headless `claude -p` + hub mod ✅

```sh
cd /tmp/hdr-probe && echo "Do exactly this: 1) call mcp__hdr-probe__send with target w1:p1 and message 'hi pi'. 2) run the Bash command: sleep 25. 3) quote any [hdr message ...] text" \
 | HERDR_PANE_ID=w1:p9 claude -p --plugin-dir /tmp/hdr-probe --debug-file /tmp/hdr-hub/debug.log --allowedTools "mcp__hdr-probe__send" "Bash(sleep:*)"
```

**Run 1:** the hub delivered `hi pi` to alpha, but the hook returned `{ text }` and the engine logged `tool.call hook skipped: returned the wrong shape (neither { result } nor { deny })`. A `tool.call` answer must be `{ result, text? }`, `{ isError: true, text }` or `{ deny }`.

**Mid-turn:** a fake Pi sent "the secret word is PINEAPPLE" during `sleep 25`. The mod called `$.session.append({ message: { type: "user", ... } })` (`running=true`), and the model quoted it after the sleep. So mid-turn delivery arrives at the next loop top.

`$.process.spawn` runs a child for the session's life; the log shows `$.process.spawn (hdr-probe): node ended (SIGTERM) in 40397ms` at session end.

## S5: interactive hub mod ✅

The interactive session ran in a temporary Herdr tab: `claude --plugin-dir /tmp/hdr-probe --debug-file ...`.
- **Presence:** the hub broadcast `{"pane":"w24:p4","kind":"cld","name":"probe"}`.
- **`@hdr-pi-al`:** the `AbovePrompt` band drew `@hdr-pi-alpha  w9:p1`. Typing a space expanded the prompt to `ask @hdr-pi-alpha`. Claude's own `@` dropdown was open at the same time and still listed the old MCP resources.
- **Submit "…say hi using your send tool":** a `prompt.submit` context line (`Herdr peer @hdr-pi-alpha: pane w9:p1 …`), then the model called the send tool and the result was `submitted`. Alpha received `{"type":"message","from":"w24:p4","text":"hi"}`.
- **Idle inbound** ("the word is MANGO"): `$.prompt.submit` started a new turn, and the model acknowledged it. Claude renders it as "› Prompt from the hdr-probe plugin", followed by an engine note that a plugin prompt starts a turn in the user's place.

## S6: names ✅

- **Pane-ID fallback:** a new session had no name and no label, so peers saw `"name":"w24:p5"`.
- **`/rename probe-claude`:** a `command.run` hook on `{ command: "rename" }` re-read the name after `next(e)` and POSTed `/hello`. Peers immediately saw `"name":"probe-claude"`. The built-in `/rename` does fire `command.run`.
- **Claude session name source:** the last `{"type":"custom-title","customTitle":...}` row in `~/.claude/projects/*/<session-id>.jsonl`, read with `grep` through `$.process.run`. `$.fs.read` rejects files over 4 MiB, and transcripts get bigger than that.
- **Herdr label fallback:** a test pane was relabelled with `herdr pane rename <pane> "build-runner"`, then a client connected with an empty name. Peers saw `{"pane":"w24:p6","kind":"pi","name":"build-runner"}`. The label comes from `herdr pane get <pane>` → `result.pane.label`, a key that is absent when unset.

## S7: compact inbound rows ✅ (needs a second plugin)

- The plugin that calls `$.prompt.submit` **cannot** restyle that row. The debug log says `hdr-probe ui.render skipped: re-entry (the plugin's own code raised it; origin hdr-probe)`.
- A second plugin, `probes/claude-mod-view`, with a `ui.render { component: "UserMessage" }` hook does see it: `origin={"kind":"plugin","name":"hdr-probe"}`. When `!e.props.isExpanded`, it returns `next({ ...e, props: { ...e.props, text: "↘ @hdr-pi-beta: Idle check: build… (ctrl+o)" } })`.
- **Screen:** `› Prompt from the hdr-probe plugin` / `❯ ↘ @hdr-pi-beta: Idle check: build artifacts uploaded to the staging bucket, … (ctrl+o)`. ctrl+o showed the full text, because `isExpanded` was true there.

## S8: mid-turn visibility ⚠️

- **Hidden user row:** `$.session.append({ type: "user" })` is stored `isMeta`. The model reads it, but the person sees **nothing**.
- **`system` notice:** `$.session.append({ type: "system", content:[text] })` did **not** show in the transcript in this test.
- **`$.ui.log(text)`** (default `to: "transcript"`): **visible** dim line `⏺ hdr-probe: ↘ @hdr-pi-beta: Mid-turn four: release notes draft is in docs/RELEASE.md, review after.` The model acted on the message in the same turn.
- **Hot-reload pitfall:** one run lost the mid-turn path because the module-level `let running` reset on hot reload while a turn was running, so the message queued as an idle prompt. Keep turn state in `$.state`.
- **Untested:** whether ctrl+o (the transcript viewer) shows `isMeta` rows.

## S9: native session mention look ✅ (observation)

- **Native session row:** typing `@hdr-mcp` in Claude showed exactly one row: `@hdr-mcp-54     message session · on this machine · active 16m ago`.
- **MCP resources rank low:** typing `@` alone listed files, then `◇ hdr:pi-pi1:w24:p2 – Pi · w24:p2`, buried among `◇ svelte:svelte://…` resources. This is the "low priority, not highlighted" problem the user reported.
- **Mods can't fix it:** the mod API has **no** way to add rows to the `@` typeahead or style prompt text. The only typeahead a mod can feed is `/` (S12).

## S10: Claude's native inbox socket ⚠️

- **Debug log advertises the socket:** `[uds-messaging] Listening: /tmp/cc-socks/<pid>.sock` and `Inject messages (auth line optional here): {"type":"auth","token":…} / {"type":"user","message":{"role":"user","content":"hello"}}`.
- **Outside post delivered:** a non-child Python process posted `{"type":"user","message":{"role":"user","content":"Inbox test …"}}\n` to the probe session's socket. It was delivered as a **peer message**: the model's peer-safety preamble appeared and it replied "Acknowledged: the nightly backup finished at 4.2 GB." The socket sent no reply bytes.
- **Render not observed:** the classifier blocked reading the pane afterwards.
- **Docs:** https://code.claude.com/docs/en/cross-session-messaging.md documents the socket, the env vars and posting from scripts. Inbound controls apply: in auto mode it's delivered, while a bypass-mode receiver holds it for approval. Only the `auth` frame is documented. The `user` frame shape comes from the debug-log hint.
- **Session registry is private:** `~/.claude/sessions/<pid>.json` is undocumented ("private protocol" per the community project `aeriondyseti/claude-message-mcp`, which is Windows-only). A Pi cannot be made a native Claude peer without relying on it.

## S11: SendMessage served by the mod ✅

- **Prompt:** "Use your SendMessage tool (not the hdr-probe send tool) to tell pi-alpha: native send check 7."
- **Log:** `hdr-probe (user) answered session.send without next() …` and `session.send to pi-alpha (model): a hook delivered it itself; hooked by hdr-probe; nothing sent`.
- **Delivered:** alpha received `"text":"native send check 7"`.
- **Answer shape:** `{ isDelivered: true }`, or `{ isDelivered: false, reason }`, which the model reads as the tool result.

## S12: native `/` command per peer ✅ (rejected UX, useful facts)

- **Registration:** `$.command.register({ name: "pi-alpha", description: "Message Pi · alpha · w9:p1", argumentHint: "<message>", immediate: true })` added `/pi-beta` and `/pi-alpha` at the **top** of Claude's native `/` menu, styled like built-ins.
- **Running `/pi-alpha the schema migration finished, rebase is safe`:** the `command.run` hook POSTed it, with no model turn. It returned `{ text, context }`.
- **Hiding peers that left:** a `command.describe` hook returning `{ ...r, isHidden: true }`, plus `$.ui.invalidate("command.describe")`, hid `/pi-beta` on the next keystroke after it left.
- **Pitfall:** under `--plugin-dir` the provider is `{"plugin":"hdr-probe@inline","tier":"user"}`. Match with `startsWith`.
- **The user rejected this UX** (one command per peer). The facts are reusable.

## S13: custom trigger and keys ✅

`prompt.edit` received typed or pasted text (one edit per paste, `key: null`), space, `left`, `backspace` and `ctrl+u`. It **never** received `up` (Claude used it for prompt history), `down`, `tab` or `right`. A custom inline picker therefore can't use arrows or Tab. That is why `/msg` uses a dialog pane instead (S14).

A `$` trigger in the band works (`ask $` → band `@hdr-pi-alpha  w9:p1`), and so does space completion (`$al` → `@hdr-pi-alpha`).

## S14: hubless `/msg` picker ✅ (the chosen UX)

- **Setup:** `node probes/fake-peers/fakepi.mjs <pane> <session> [sendTo text]` wrote `/tmp/hdr-peers/<pane>.json` and listened on `/tmp/hdr-peers/<pane>.sock`. Claude ran with `claude --plugin-dir /tmp/hdr-probe2`.
- **`/msg` → dialog pane** (`$.ui.open({ id: "msg", focus: true, closeOnEscape: true, rows })`) with an `autoFocus` `Select`:
  ```
  │ none ▴                                              ✕ │
  │   Files  Pi · w1V:p3      ← Herdr pane label
  │   alpha  Pi · w9:p1       ← session name
  │   w9:p2  Pi · w9:p2       ← pane-ID fallback
  │ ↑↓ choose · Enter insert · Esc cancel
  ```
  `none ▴` appears because `value` was unset; set `value` to the first option.
- **Selection:** ↓ and Enter → `onSelect` → `$.ui.close` + `$.prompt.fill({ text: "@pi-alpha ", mode: "insert" })`. The prompt became `❯ @pi-alpha `, and **Claude's own `@` dropdown did not open**.
- **Typed message and Enter:** `prompt.submit` added the context `@pi-alpha is a Pi session in Herdr pane w9:p1. To message it, use SendMessage with to: "pi-alpha".` Claude called SendMessage, `session.send` delivered it, and alpha logged `RECEIVED {"from":{"kind":"cld","pane":"w24:p8","name":"w24:p8"},"text":"The schema migration finished, so rebasing on main is safe now."}`. **Claude reworded the text**, as native session mentions do.
- **Bugs fixed during the smoke:**
  - `$.state.set` takes `{ plugin, key }`, not an `atom`; use `update($, atom, fn)`.
  - Helpers that take `$` must be top-level functions.
- ⚠️ **Workspace slip:** the `Files` peer claimed pane `w1V:p3` from *another* workspace, in a `/tmp` file only. Don't repeat that.

## S15: hubless Pi → Claude, idle ✅

`node fakepi.mjs w9:p3 beta w24:p8 "Got it, rebasing now. Tests ran: 214 green."` printed `SENT 200`. The mod's inbox child printed the line, and `$.prompt.submit` started a turn. Claude answered and correctly attributed the message to `pi-beta (pane w9:p3)`.

## S16: real Pi `/msg` picker ✅

`pi -ne -e /tmp/pi-msg-probe.ts` (`-ne` disables other extensions). `/msg` drew Pi's native selector:
```
 Message a peer
 → w1V:p3  Pi · w1V:p3
   w24:p8  Claude · w24:p8
   alpha  Pi · w9:p1
 ↑↓ navigate  enter select  escape/ctrl+c cancel
```
↓↓ and Enter → `ctx.ui.pasteToEditor("@pi-alpha ")`, and the editor showed `@pi-alpha ` with typing continuing after it. The screen lagged one read behind.

## S17: lifecycle with real Claude + real Pi ✅ (⚠️ ran in workspace w27 "other-workspace" by mistake)

| Step | Registry folder |
|---|---|
| both started | `w27_p8.json` `{"kind":"cld","pane":"w27:p8","session":"",…}` + `.sock`; `w27_p9.json` `{"kind":"pi",…}` + `.sock` |
| Claude `/rename cld-two`, Pi `/name pi-two` | `"session":"cld-two"`, `"session":"pi-two"` |
| Claude `/clear` | record **kept** on purpose (process lives on; no `session.start` follows a clear) |
| Claude `/exit` | Claude's record and socket **removed** (`session.end`, reason ≠ `clear`, `rm -f` via `$.process.run`) |
| Pi `/quit` | Pi's record and socket **removed** (`session_shutdown`) |

- **Real delivery:** Claude `/msg` → `pi-two` → "say hello and ask it to reply with just the word pong". The real Pi showed `[hdr] [message from @cld-cld-two · w27:p8] Hello from cld-two! Please reply with just the word: pong` and replied `pong`. It used `pi.sendMessage({ customType, content, display: true }, { triggerTurn: true, deliverAs: "steer" })` while idle and cost $0.006.
- **Path from Claude's debug log:** 1× `POST http://peer/msg over /tmp/hdr-peers/w27_p9.sock`, 3× `GET /ping`, 3× `herdr pane list`, and nothing else from Herdr.
- **Cosmetic:** `@pi-pi-two` shows a doubled prefix because the session name already started with `pi-`. Strip it (see the spec, Names).

## S18: crash rerun (forked agent, workspace w24 only) ✅

- **Setup:** real Pi (PID 65159) killed with `kill -9`; its record and socket stayed behind.
- **`/msg` filtered the dead peer:**
  ```
  ping w24:fake1: resolved status=200 ok=true
  ping w24:pA: rejected … ECONNREFUSED
  msg: live=["w24:fake1"]
  ```
  With every peer dead, it printed `hdr-probe2: No live peers.`
- **The earlier "dead Pi listed" anomaly was a test error:** `pgrep` found nothing and `kill -9` never ran.
- **"Mention inserted without Enter" anomaly:** the earlier picker was still open and **holding the keyboard**, so the next Enter picked its only row. This reproduced exactly (`msg: onSelect w24:fake1`).
- **Remaining gaps:**
  - Stale records are filtered but never deleted.
  - An open picker captures keys, which is normal `Select` behaviour.
  - The cosmetic `none ▴` header.

## Build checks (2026-10-03, session `a2a-msg-build1`, workspace w24 only)

Run against the real packages: `claude --plugin-dir claude/a2a-msg --plugin-dir claude/a2a-msg-view` and `pi -ne -e pi/a2a-msg/index.ts`, in one test tab (`w24:tA`, panes `pC` `pD` `pE`), with the default registry `~/.local/state/a2a-msg/w24/`. The tab, processes and registry folders were removed afterwards.

| # | What | Result |
|---|---|---|
| S19 | Unit tests: `npm test` (core 13, inbox 3, Pi extension 3); `npm run typecheck`; `tsc -p` both mods; `claude plugin validate` both; `claude plugin test` (core 2, view 1) | ✅ all pass |
| S20 | Two real Pis: records `0600` in a `0700` folder; `/name` rewrites them; `@` lists `@pi-beta` (no doubled prefix) ahead of files; alpha → beta → "pong" back, idle | ✅ |
| S21 | Pi renderer: compact `↘ @pi-alpha: …`; ctrl+o shows `↘ @pi-alpha · w24:pC` + full text | ✅ |
| S22 | Pi mid-stream: a message POSTed during `sleep 15` was steered in after the tool call and quoted in the same run | ✅ |
| S23 | Claude `/msg`: picker of Pi peers only, first row preselected (no `none ▴`); ↓ Enter → `@pi-beta `; SendMessage → beta replied "pong" → back to Claude, no loop | ✅ |
| S24 | Claude idle inbound: `› Prompt from the a2a-msg plugin` / `❯ ↘ @pi-alpha: … (ctrl+o)`; ctrl+o shows the full text | ✅ after a fix: a stored row's text starts with "The a2a-msg plugin sent a message:" |
| S25 | Claude mid-turn inbound (during `sleep 20`): visible `⏺ a2a-msg: ↘ @pi-beta: …`, quoted in the same turn | ✅ |
| S26 | Esc-interrupted turn: `turn.complete` fired; the next message started its own turn | ✅ |
| S27 | ctrl+o and mid-turn (`isMeta`) rows: the row is **not** shown, only the log line | ⚠️ known limit (README) |
| S28 | Pi → Claude through Pi's `/msg`: Claude peers only; mention context → `send_message` → Claude prompt | ✅ after a fix: `pasteToEditor` didn't redraw; `setStatus` now forces one |
| S29 | Nested processes: Pi's bash ran `pi -p …`, and Claude's Bash ran `claude -p --plugin-dir …`; both children stayed off (`a2a-msg is off: pane … belongs to the agent that started this process`), and the parents' records and sockets were untouched and still answered | ✅ |
| S30 | Lifecycle: Claude hot reload (new helper, owner kept); `/clear` keeps the record, then `/rename lead` updates it; collision → `@pi-alpha-w24-pC` / `@pi-alpha-w24-pD`, and the second routed correctly; `kill -9` Pi → skipped **and** its files deleted; Pi `/new` recreates the record (no name); Pi `/quit` and Claude `/exit` remove theirs; Claude's helper exits | ✅ |

Pitfalls found while building:
- **Node keep-alive:** Node's default HTTP agent reuses connections, so a request after the peer restarts gets `EPIPE`. Use `agent: false`.
- **`claude plugin test` answers:** an op hook answers `{ value }` or `{ deny }`, never a bare value, `null` or `{}`. The test must answer `session.start`, `session.id`, `ui.log`, `ui.toast` and `command.register` as well as env, process, fs and http. Work the plugin leaves running (the inbox loop) isn't awaited, so await a signal from your own mock.
- **Shared panes:** the person can be using the test panes too. Once a stray prompt (`@cld-w24-pE /msg`) came from their pick plus my scripted `/msg` + Enter. Read the pane before typing.
- **The engine's own tsconfig** sets `noUncheckedIndexedAccess`. The root tsconfig now does too, so `core.ts` passes both.

## Not yet tested
1. **D6:** Claude's native inbox socket (S10) as the inbound path. Optional; it needs the user watching the pane.
2. **Verbatim delivery mode:** not built (D1 chose relay).
3. **Surfaces other than the terminal:** the picker narrows on `Select`, so mobile shows a notice. The desktop and VS Code surfaces were never tried.
