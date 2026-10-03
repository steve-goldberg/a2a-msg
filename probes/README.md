# Probes (throwaway research code, copied from /tmp on 2026-10-03)

This code was written to answer questions, not to ship, and the paths are hardcoded. To run any of it again, copy it back to `/tmp` or edit the constants. Engine-generated `.claude-plugin/types/` folders were left out; Claude regenerates them when it loads a plugin.

| Folder | What it is | Status | Smokes |
|---|---|---|---|
| `claude-mod-msg/` | **The chosen design.** Hubless `/msg` picker, Unix-socket inbox helper (`listener.mjs`), registry file lifecycle, `prompt.submit` mention context, `session.send` delivery. The fork added workspace-scoped labels and debug logs | latest | S14 S15 S17 S18 |
| `pi-extension-msg/pi-msg-probe.ts` | **Pi half of the chosen design.** `/msg` with `ctx.ui.select` + `pasteToEditor`, in-process socket inbox, registry lifecycle, `pi.sendMessage` inbound | latest | S16 S17 |
| `fake-peers/fakepi.mjs` | stand-in Pi peer for the hubless design: writes a record, listens, optionally sends one message | latest | S14 S15 |
| `claude-mod-view/` | second plugin that compacts the core's plugin-prompt rows (`↘ @tok: …`), expandable with ctrl+o | latest (needed) | S7 |
| `claude-mod-hub/` | earlier hub-based mod. Covers the `@hdr-` band, space completion, `$` trigger, `prompt.edit` key logging, per-peer `/` commands + `command.describe` hiding, `session.send`, mid-turn `$.ui.log` | superseded (facts reused) | S1 S4–S8 S11–S13 |
| `hub/hub.ts`, `hub/client.mjs` | Bun WebSocket hub + Node WebSocket client (presence broadcast, `/send`, `/hello` rename, Herdr label lookup) | superseded | S3–S6 |

## Hardcoded values
- Registry folder: `/tmp/hdr-peers` in `claude-mod-msg`, `fake-peers` and `pi-extension-msg`. The spec replaces it with `~/.local/state/a2a-msg/<workspace>/`.
- Hub: `http://127.0.0.1:8766`, and `/tmp/hdr-hub/client.mjs` referenced from `claude-mod-hub` (it calls `$.plugin.root/hub-client.mjs`).
- Plugin names: `hdr-probe`, `hdr-probe2`, `hdr-view`. State keys and the view plugin's matching depend on them.

## Running (always in your own Herdr workspace)
```sh
WS=${HERDR_PANE_ID%%:*}
mkdir -p /tmp/hdr-peers
node probes/fake-peers/fakepi.mjs "$WS:fakeA" alpha &            # a live fake Pi peer in YOUR workspace
read PANE TAB < <(herdr tab create --workspace "$WS" --cwd /tmp/hdr-probe2 --label probe --no-focus \
  | python3 -c "import json,sys; r=json.load(sys.stdin)['result']; print(r['root_pane']['pane_id'], r['tab']['tab_id'])")
herdr pane run "$PANE" "claude --plugin-dir /tmp/hdr-probe2 --plugin-dir /tmp/hdr-view --debug-file /tmp/a2a-debug.log"
# answer the trust prompt: herdr pane send-keys "$PANE" down; herdr pane send-keys "$PANE" Enter
herdr pane send-text "$PANE" "/msg"; herdr pane send-keys "$PANE" Enter; herdr pane read "$PANE" | tail -12
# Pi: herdr pane run "$PI_PANE" "pi -ne -e $PWD/probes/pi-extension-msg/pi-msg-probe.ts"
# cleanup: herdr tab close "$TAB"; pkill -f fakepi.mjs; rm -rf /tmp/hdr-peers
```
