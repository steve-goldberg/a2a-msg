# a2a-msg

Direct peer messaging between Pi and Claude Code sessions in one Herdr workspace. It is a Claude Code mod pair plus a Pi package that talk HTTP/1.1 over per-agent Unix sockets. There is no MCP, no hub and no `herdr agent prompt`. Herdr supplies only `HERDR_PANE_ID` and pane labels (`herdr pane list --workspace`, read-only).

## Routing (user decisions D1–D4, SPEC.md §8)
- **Claude:** `/msg` opens a picker of **Pi** peers and inserts `@pi-<name>`. Claude `@` stays native (Claude↔Claude is out of scope).
- **Pi:** `/msg` opens a picker of **Claude** peers and inserts `@cld-<name>`. Pi `@` completes **Pi** peers.
- **Relay:** on submit, each mentioned live peer is described to the model, which writes the message with SendMessage (Claude) or `send_message` (Pi). Verbatim sending isn't built.
- **Incoming messages:** a compact `↘ @tok: first line…` that expands with ctrl+o. In Claude, idle delivery is a plugin prompt; mid-turn delivery is `$.session.append` plus a `$.ui.log` line, which can't be expanded.
- **Names:** session name, else Herdr label, else pane ID. Tokens never double the `pi-`/`cld-` prefix. Collisions append `-<pane>` to each.

## Files
| Path | Role |
|---|---|
| `claude/a2a-msg/hooks/core.ts` | The shared contract, pure (no Node, no DOM): identity, paths, names and tokens, records, message validation, the texts models read. Imported by the mod, `inbox.ts` and the Pi extension |
| `claude/a2a-msg/inbox.ts` | Node HTTP inbox (`GET /ping`, `POST /msg`). Pi calls `listen()` in-process; Claude spawns `node inbox.ts <sock> <kind> <pane>`, which prints `{"ready":true}`, then one JSON line per message |
| `claude/a2a-msg/hooks/register.tsx` | Claude core mod: `session.start` (identity, `/msg`, inbox loop, record), picker `Pane`, `prompt.submit` context, `session.send` → socket (Pi tokens and panes only), rename, `session.end` |
| `claude/a2a-msg/types/index.d.ts` | `$.state` contract (`peers`, `running`, `owner`). Must be self-contained |
| `claude/a2a-msg-view/hooks/register.ts` | Second mod (the re-entry rule): compacts the core's `UserMessage` rows |
| `pi/a2a-msg/index.ts` | Pi package: in-process inbox, registry, `/msg`, `@` provider, `before_agent_start` context, `send_message`, renderer |
| `test/*.test.ts`, `pi/a2a-msg/index.test.ts` | `node --test`: core, inbox over real sockets, Pi extension with a fake `pi` and a fake `herdr` |
| `claude/*/tests/*.test.ts(x)` | `claude plugin test` (the host nouns are mocked in the test) |
| `scripts/link-pi.sh`, `test/pi-host.mjs` | Expose the installed Pi's `typebox` and `@earendil-works/*` under `.host/` for tsc and tests only |
| `SPEC.md`, `SMOKES.md`, `HANDOFF.md`, `probes/`, `evidence/` | Design, live smokes S1–S30, the research handoff, research code and evidence |

## Protocol
- **Registry:** `${A2A_MSG_DIR:-~/.local/state/a2a-msg}/<ws>/<pane>.json` and `.sock` (folder 0700, socket 0600). Record v1: `{v,kind:"pi"|"claude",pane,workspace,session,sock,updatedAt}`, written to a temp file and renamed. Readers accept only records of this workspace whose `sock` is the path its pane implies.
- **Liveness:** ping times out at 1.5 s. A refused or missing socket deletes the record and socket, unless `updatedAt` changed in between; a timeout only skips the peer.
- **`POST /msg`:** `{v,id,from:{kind,pane,name},text,sentAt}`. 400 for a bad body or control characters (only `\n` and `\t` allowed), 403 for another workspace, 413 for over 1 MiB. Senders never retry.
- **`A2A_MSG_OWNER`:** a nested `claude -p`/`pi -p` inherits the pane, so a child seeing another owner stays off. The owner is the PID in Pi and a UUID in `$.state` in Claude.

## Commands
```sh
npm install && npm run link-pi      # once
npm test && npm run typecheck       # 19 node tests; strict tsc
npx tsc -p claude/a2a-msg && npx tsc -p claude/a2a-msg-view    # needs .claude-plugin/types, laid by a load
claude plugin validate claude/<mod> && claude plugin test claude/<mod>
claude --plugin-dir "$PWD/claude/a2a-msg" --plugin-dir "$PWD/claude/a2a-msg-view"    # dev load, hot-reloads
pi -ne -e "$PWD/pi/a2a-msg/index.ts"
```

## Rules and gotchas
- **User's global rules:** fail fast (no silent fallbacks), read before editing, check APIs against the types, run what you build.
- **Mods API is early access.** The authority is the `plugin-authoring` skill's `types/claude-code.d.ts`. Helpers that take `$` must be top-level function declarations. `$.env.get` names and `$.state` refs must be literals. No `$.fs` rename/delete: use `$.process.run(["mv"|"rm"])`. `$.http.fetch` has no timeout.
- **Engine tsconfig** sets `noUncheckedIndexedAccess` (the root tsconfig matches). `core.ts` is imported with its `.ts` suffix.
- **`claude plugin test`:** op hooks answer `{ value }`/`{ deny }`. Answer `session.start`, `session.id` and `ui.log` too. The detached inbox loop isn't awaited.
- **Node clients use `agent: false`.** Keep-alive reuse gets `EPIPE` after a peer restarts.
- **Pi:** `pasteToEditor` doesn't redraw; follow it with `ctx.ui.setStatus("a2a-msg", undefined)`. A stored Claude plugin prompt is prefixed "The a2a-msg plugin sent a message:".
- **Live tests:** only in your own Herdr workspace (`herdr tab create --workspace "${HERDR_PANE_ID%%:*}"`). Read a pane before typing; the person may be using it. Never read `~/.claude/sessions/*`. Clean up tabs, processes and `~/.local/state/a2a-msg` leftovers.
- **Global config** (`CLAUDE_CODE_PLUGIN_DIRS`, `pi install`, the `hdr` MCP) changes only with the user's approval. As of 2026-10-03: not installed, `hdr` MCP kept (D5), native-inbox test skipped (D6), mid-turn stays read-now.
