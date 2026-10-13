# Pi receipt visibility diagnosis (2026-10-13)

Live checks used only the user-designated testing workspace and its existing Pi and Claude instances. Workspace/pane identifiers below are generic. No non-test sessions were prompted or restarted, no topology was created, and globally watched Claude runtime sources were not changed.

## Reproduction

An idle Claude → Pi send displayed the compact incoming row and Pi's acknowledgement reached Claude.

For the failing case, Pi ran a controlled 75-second tool call. Claude sent one unique message through its real `SendMessage` plugin hook while that tool was running. A temporary marker proved the tool had not finished when the Pi screen was inspected.

Before the fix:

```text
paused_at_snapshot: true
sender_completed_after: 6.63 seconds
incoming_receipt_row_visible: false
```

After the tool finished, the incoming row appeared and Pi acknowledged the message. This establishes delayed receipt visibility, not a lost message. Senders were not retried.

## Cause and change

Pi's SDK `AgentSession.sendCustomMessage()` queues a streamed custom steer without emitting the message-start UI event until the agent consumes it. The previous implementation tied both the receipt row and model delivery to that queued message. Consequently, an accepted socket delivery could remain invisible for the duration of a tool call.

`pi/a2a-msg/index.ts` now records the receipt immediately with `appendEntry()` and an entry renderer. It still sends exactly one custom steer to the model, but that custom message has `display: false` so consumption does not add a second receipt row. Entry data is excluded from model context. The old message renderer remains for previously stored displayed messages. Both renderers share the same compact/expanded row and honor output padding.

The Node regression posts through a real inbox and exercises the installed SDK's actual streaming branch with an unconsumed steering queue. It fails on the old implementation because no receipt entry exists yet; the new implementation stores a renderable receipt while the model message remains queued. No provider or model request is needed for that regression.

The test-only package resolver now redirects only packages explicitly linked under `.host`; SDK-internal dependencies resolve from their installed package location.

## Verification

After reloading **only the testing Pi** and rerunning the controlled live case with a fresh message identifier:

```text
paused_at_snapshot: true
sender_completed_after: 5.61 seconds
incoming_receipt_row_visible: true
receipt_rows_after_tool_completion: 1
Pi_acknowledgement_sent: true
```

An additional idle, two-line message produced one compact receipt, `ctrl+o` revealed its full text and sender pane, and Pi's acknowledgement was sent successfully. The shortcut was restored to its original collapsed state. A second testing-Pi reload restored that saved receipt exactly once; its journal contained one receipt entry and one hidden model message.

- `npm test`: **35 passed**.
- `npm run typecheck`: passed.
- `git diff --check`: passed.
- No Claude runtime source edits; unrelated pre-existing working-tree edits preserved.

## Separate Claude warning

The `a2a-msg is off: the inbox stopped (exit 0)` notice is a separate lifecycle-reporting issue. A normal helper exit can mean supersession, an owner-requested close, or graceful handling of SIGINT/SIGTERM; exit status alone does not identify the cause. A two-helper temporary fixture reproduced supersession with an old helper exiting 0 while the replacement continued answering ping. No retained trace proves which path caused the originally reported warning.

This Pi visibility patch does **not** change or claim to fix that warning. Changing the globally watched Claude plugin would reload helpers in unrelated live sessions, which was outside the permitted testing scope.
