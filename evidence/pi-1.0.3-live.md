# Pi 1.0.3 install and live verification — 2026-10-05

Performed from `w24:pH`, with user approval to update, install, test and commit the Pi side.

## Development tooling

- `scripts/link-pi.sh` now follows the managed launcher's `install/current-version` pointer and resolves dependencies from the actual Pi CLI. Both npm-global nested dependencies and managed-install hoisted dependencies are supported.
- All package paths are resolved before replacing `.host`; invalid versions, missing releases and missing dependencies fail without deleting existing links.
- `typebox` is declared as a host-provided peer dependency.
- `bash -n scripts/link-pi.sh`: passed.
- `npm run link-pi`: linked Pi 1.0.3 under `~/.pi/agent/install/releases/1.0.3/node_modules/`.
- `npm test`: **24 passed, 0 failed** (19 existing tests plus 5 linker regression tests).
- `npm run typecheck`: passed.

## Installation

Ran:

```sh
pi install /absolute/path/to/a2a-msg/pi/a2a-msg
pi list
```

Pi confirmed the install and listed the package under **User packages**. It stores the source as `../../path/to/a2a-msg/pi/a2a-msg`, relative to `~/.pi/agent/`. No Pi application update, MCP removal or Claude config change was performed.

## Live smoke

Created test tab `w24:tD` in the caller's own workspace, with cwd `/absolute/path/to/a2a-msg`:

- Pi **1.0.3**, pane `w24:pK`: `pi --no-session --name a2a-pi103 --thinking low --offline`.
- Claude Code **2.1.289**, pane `w24:pM`: plain `claude`, then `/rename a2a-claude103`.
- Neither agent used explicit extension/plugin paths: both loaded their installed configuration.

Observed:

1. Pi startup listed `a2a-msg`; both panes registered live sockets.
2. Pi `/msg` displayed `a2a-claude103  Claude · w24:pM`. Selecting it inserted `@cld-a2a-claude103` into the editor.
3. Pi called `send_message` with `to: "cld-a2a-claude103"` and the nonce `A2A-PI103-PING-20261005`. Its tool result was `Delivered to @cld-a2a-claude103 (w24:pM). Delivery means submitted, not done.`
4. Claude displayed the compact incoming plugin row. Native `SendMessage` returned through the plugin hook: `Delivered by a plugin hook; nothing else was sent.`
5. Pi displayed `↘ @cld-a2a-claude103: A2A-PI103-PONG-20261005`, then printed `A2A-PI103-ROUNDTRIP-PASS`. No automatic reply loop occurred.
6. Pi ctrl+o expanded the row to `↘ @cld-a2a-claude103 · w24:pM` and the full pong body.
7. After Pi `/reload`, its socket returned `{"v":1,"kind":"pi","pane":"w24:pK"}` to `GET /ping`, and `/msg` still listed the Claude peer.
8. Pi `/quit` and Claude `/exit` returned both panes to their shells. Assertions confirmed all four test record/socket paths (`w24_pK.{json,sock}`, `w24_pM.{json,sock}`) were absent. The test tab was closed.

Unrelated startup warnings: existing duplicate skills and invalid frontmatter in the pass-env skill. They did not prevent extension loading or messaging. Mid-turn delivery, Pi-to-Pi messaging and crash recovery were not rerun in this smoke; the earlier checks remain in `SMOKES.md`.
