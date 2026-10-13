# Lifecycle/discovery diagnosis (2026-10-13)

## Symptom and scope

Live workspace, pane and session identifiers below are anonymized.

Pi `/msg` in `wDemo` reported “No live Claude peers in this Herdr workspace” despite a live Claude pane (`wDemo:p4`). The handoff found a live Claude inbox helper with an unlinked listener pathname and no registry record. Discovery already rescans on every call: a late-start control passed before any runtime changes.

The globally installed Claude mods watch this repository. Editing their sources hot-reloaded existing sessions, including sessions outside the development workspace. No prompts were sent to those sessions, and none were quit or resumed as part of verification.

## Established failures (not guesses)

Before the fixes:

- `npm test` failed **a failed startup probe must not unlink an inbox that has since started**. A controlled failed probe was delivered after a real Unix listener bound, before record refresh. Discovery unlinked that listener's address.
- `npm test` failed **an old inbox closing cannot unlink the replacement listener** and **an old Pi runtime shutting down leaves its replacement discoverable and receiving**. Node closes unlink their bound Unix pathname; blindly replacing a live pathname lets an old close destroy the new generation.
- `claude plugin test claude/a2a-msg` failed **resume and clear keep the process inbox registered**: `resume` deleted the files even though the process and detached helper can continue.
- After the user observed the live “belongs to the agent that started this process” notice, a regression with an existing owner and missing session state failed **reload after conversation state is lost does not reject the original process owner**. The generated API documents `$.state` as session-scoped, not process-scoped. An owner set in the environment survives conversation changes; its state counterpart need not.

These mechanisms are established independently. There is no retained trace proving which cleanup first removed the peer's original socket; do not claim the historical deletion trigger is known.

## Fix and invariants

- The shared Node inbox owns binding, record publication, names, repair and shutdown. Pane paths remain canonical and workspace-scoped, but are aliases to private generation targets. Closing a generation removes only its own targets, never a replacement's aliases.
- Inboxes check their paths every second. Missing aliases/records are restored; an unlinked private listener is rebound. A superseded generation retires. This is listener maintenance, not retrying messages.
- Discovery preserves present panes, including unlabeled ones. Managed crash cleanup requires a dead OS owner and removes only that generation's private targets. Legacy cleanup can prune only an absent pane's unchanged record, never its canonical socket.
- Claude keeps the inbox through `/clear` and `/resume`. Names and exit requests use generation-checked helper routes, so an old mod cannot rename or stop its replacement.
- Claude uses `claude:<host PID>` for process ownership. The helper reads its parent's launch environment privately to distinguish inherited owners from runtime-set legacy UUIDs; only PID/presence information is returned. Real subprocess tests verify that distinction, and nested agents remain disabled. The old state owner is retained only as a compatibility mirror.
- Routing, workspace validation, body validation, timeouts and the no-message-retry rule remain unchanged.

## Verification

`npm run link-pi` refreshed only the ignored development links to installed Pi **1.1.0**.

Commands:

```sh
npm test
npm run typecheck
npx tsc -p claude/a2a-msg
npx tsc -p claude/a2a-msg-view
claude plugin validate claude/a2a-msg
claude plugin validate claude/a2a-msg-view
claude plugin test claude/a2a-msg
claude plugin test claude/a2a-msg-view
```

Final results: **34 Node tests and 7 Claude plugin tests passed**; all three strict typechecks, both plugin validations and `git diff --check` passed.

Regression coverage includes real Unix sockets, real helper subprocesses, late peers, failed startup probes, old/new generation cleanup, lost-path automatic recovery, dead-owner cleanup, workspace isolation, owner migration and the nested-process guard. Claude plugin tests mock host nouns; they are not substitutes for live checks.

A read-only live check after hot reload found the peer's record restored, `GET /ping` returned `200 {"v":1,"kind":"claude","pane":"wDemo:p4"}`, and the actual Pi `/msg` handler returned (identifiers anonymized):

```text
example-session  Claude · wDemo:p4
```

The harness dispatched no session lifecycle events, opened no inbox in the user's pane, returned no picker selection, and sent no message. Recovery did not require quitting or resuming the Claude peer. The user's interactive picker and message delivery to that peer were deliberately not driven by the agent; the user can confirm `/msg` themselves.
