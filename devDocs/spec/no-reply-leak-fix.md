# NO_REPLY / `(no response)` Delivery Fix

## Context

This spec originally tracked a bug where the runtime leaked `NO_REPLY` to users instead of suppressing it. That historical issue has been partially fixed in the current working tree, but the document had drifted behind the code.

The current goal is to document:
1. what is already fixed,
2. what remaining delivery gaps still exist,
3. the recommended implementation order for the remaining code changes.

---

## Historical bug chain

The original failure mode was:

1. A turn produced `NO_REPLY`.
2. The lifecycle guard blocked silent completion because the session still had pending user-visible detached-run delivery.
3. The turn proceeded into terminal dispatch instead of returning early.
4. The literal `NO_REPLY` or an empty rendered reply became user-visible.
5. Heartbeat/system turns could repeat this cycle indefinitely.

That bug was real, but several parts of the original root cause are now fixed.

---

## Current code state

### Completed / already implemented

#### 1. System-internal source exemption exists
- `src/runtime/host/message-handler/flow/execution-flow.ts:21-26`
- `src/runtime/host/message-handler/flow/execution-flow.ts:127-133`

`SYSTEM_INTERNAL_SOURCES` already exempts these turns from the lifecycle guard:
- `heartbeat`
- `heartbeat-wake`
- `detached-run-announce`
- `watchdog`

This means system-internal turns no longer get forced out of silence purely because detached-run delivery is pending.

#### 2. Heartbeat triage exists
- `src/runtime/host/heartbeat.ts:227-291`
- `src/runtime/host/heartbeat.ts:392-411`

Heartbeat no longer always enters the full main-agent execution path. A lightweight triage call can now return `no_reply` before dispatching to the main execution flow.

#### 3. Accepted ack delivery is no longer the main live risk for new runs
- `src/runtime/host/sessions/subagent-registry.ts:155-165`

`register()` now skips the direct `accepted` announcement and marks `ackDelivery` as delivered immediately. That removes the previous “accepted ack stuck pending forever” path for newly registered runs.

#### 4. Ack reconciliation retry exists
- `src/runtime/host/sessions/subagent-registry.ts:822-895`

`reconcileOrphanedRuns()` now retries pending ack delivery and records retry failure state.

#### 5. Existing tests cover the heartbeat suppression path
- `src/runtime/host/message-handler/flow/execution-flow.test.ts:341-388`

Current tests already prove:
- heartbeat + pending ack + `NO_REPLY` => suppressed
- heartbeat + pending terminal delivery + `NO_REPLY` => suppressed
- user turn + pending ack + `NO_REPLY` => still blocked by lifecycle guard

---

## Remaining problems

### Problem A — empty terminal reply can still surface as `(no response)`

#### Evidence
- `src/runtime/host/message-handler/flow/execution-flow.ts:398-472`
- `src/runtime/host/message-handler/services/reply-dispatcher.ts:52-58`
- runtime log evidence from `turn:2965`

Observed runtime sequence:
- `assistantMessageFound: true`
- `Terminal reply decision` reports `terminalSource: "none"`, `terminalChars: 0`
- outbound send still happens
- `reply-dispatcher` converts the empty rendered text into `"(no response)"`

#### Why this still happens
`execution-flow` currently uses only `agent_end.fullText` / streamed text to derive `finalReplyText`:
- `src/runtime/host/message-handler/flow/execution-flow.ts:232-235`
- `src/runtime/host/message-handler/flow/execution-flow.ts:288-292`
- `src/runtime/host/message-handler/flow/execution-flow.ts:354-357`
- `src/runtime/host/message-handler/flow/execution-flow.ts:363`

But `prompt-coordinator` separately proves that an assistant message may still exist in agent state even when no usable terminal event text was captured:
- `src/runtime/host/message-handler/services/prompt-coordinator.ts:310-321`

So the current execution flow can end up in this state:
- assistant message exists in agent state,
- but no terminal event text was captured,
- terminal decision becomes `source: "none"`,
- dispatch still proceeds,
- fallback text becomes `(no response)`.

### Problem B — lifecycle guard semantics are broader than the name suggests

#### Current behavior
- `src/runtime/host/reply-utils.ts:46-72`
- `src/runtime/host/sessions/subagent-registry.ts:363-388`

`checkSilentReplyAllowed(sessionKey)` is named around “pending acknowledgement”, but the actual registry check also blocks on:
- undelivered ack, **or**
- terminal runs whose `terminalDelivery` is not delivered

That is broader than “ack pending”. The current behavior may still be correct, but the naming and mental model are misleading.

### Problem C — internal source coverage is ad hoc

The source exemption currently lives as a local `Set` in `execution-flow.ts`. That works, but it is fragile:
- it is easy to add a new internal source elsewhere and forget to classify it,
- tests currently focus on heartbeat and do not fully cover all internal entrypoints.

Relevant sources currently visible in runtime/host flow:
- `heartbeat` (`heartbeat.ts:335`)
- `heartbeat-wake` (`heartbeat.ts:172`)
- `detached-run-announce` (`subagent-announce.ts:120`)
- `watchdog` is treated as internal in `execution-flow.ts`, but watchdog wake currently enters a separate path (`message-handler.ts:987-999` / queue `watchdog_wake`).

### Problem D — `(no response)` is still a user-visible last-resort fallback

- `src/runtime/host/message-handler/services/reply-dispatcher.ts:58`

This fallback is useful as a hard guard against empty outbound payloads, but it also means upstream empty-reply bugs become visible to end users instead of being suppressed or converted into a better deterministic message.

---

## Recommended implementation plan

### Fix R1 — add agent-message fallback for terminal reply ownership

**Priority: highest**

#### Goal
If `execution-flow` does not capture terminal text from stream events, but the prompt coordinator confirms there is an assistant message in agent state, use that assistant message as the terminal reply source before dispatch.

#### Why
This directly addresses the live `(no response)` case seen in logs.

#### Recommended shape
Extend the prompt execution contract so `execution-flow` can recover terminal text from the final assistant message when `agent_end.fullText` is absent.

Preferred options, in order:

1. **Best option**: make `runPromptWithFallback` return terminal text metadata
   - return `{ terminalText?: string, source: "agent_end" | "assistant_message" | "none" }`
   - `execution-flow` then uses that instead of relying only on stream callbacks

2. **Smaller local option**: expose a deps helper that returns the latest assistant text after prompt completion
   - e.g. `getLatestAssistantReplyText(sessionKey, agentId)`
   - only used when `streamTerminalText` is undefined

3. **Avoid**: attempting to infer from logs or from unrelated session snapshot state

#### Suggested file changes
- `src/runtime/host/message-handler/contract.ts`
- `src/runtime/host/message-handler/services/orchestrator-deps-slices.ts`
- `src/runtime/host/message-handler/flow/execution-flow.ts`
- likely `src/runtime/host/message-handler/services/prompt-coordinator.ts`
- possibly `src/runtime/host/message-handler/services/prompt-runner.ts`

#### Behavioral rule
Order of terminal reply ownership should become:
1. `agent_end.fullText`
2. latest assistant message text from agent state
3. accumulated streamed text
4. no terminal text

That is better than the current order because it handles missing terminal event propagation while still preferring in-turn final text.

#### Tests required
- `execution-flow.test.ts`: no `agent_end.fullText`, assistant message exists => dispatches assistant text, not `(no response)`
- `execution-flow.test.ts`: assistant message contains only hidden thinking => still treated as empty after render
- `execution-flow.test.ts`: both terminal event text and assistant message exist => terminal event text remains authoritative

---

### Fix R2 — suppress empty terminal replies before `reply-dispatcher` fallback on silent/internal paths

**Priority: high**

#### Goal
Prevent known-empty terminal replies from being blindly dispatched into `reply-dispatcher`, where they become `(no response)`.

#### Recommended rule
After terminal reply resolution and rendering, if `terminalReplyText` is empty:
- if the turn is system-internal => suppress and return handled
- if the turn is user-visible but lifecycle guard forced reply because detached work is pending => send a deterministic task-progress acknowledgement instead of empty text
- otherwise treat as a genuine runtime anomaly and log loudly

#### Reuse candidates
Reuse deterministic lifecycle/task wording rather than inventing new copy:
- `src/runtime/host/sessions/async-task-delivery.ts:78-112` (`buildSimpleAckMessage`)

Possible helper extraction:
- small helper in execution flow or reply service that builds a deterministic fallback like:
  - `Working on your background tasks. Use /tasks for details.`

#### Suggested file changes
- `src/runtime/host/message-handler/flow/execution-flow.ts`
- optional helper in `src/runtime/host/sessions/async-task-delivery.ts` or a new small reply helper file
- keep `reply-dispatcher.ts` fallback unchanged initially; fix upstream first

#### Tests required
- user turn + lifecycle guard blocked `NO_REPLY` + empty rendered reply => deterministic background-task message, not `(no response)`
- internal turn + empty rendered reply => no dispatch

---

### Fix R3 — centralize internal turn classification

**Priority: medium**

#### Goal
Move internal-source classification out of a local `Set` and into a shared helper so future internal sources do not regress silently.

#### Suggested shape
Create a tiny shared helper such as:
- `isSystemInternalTurnSource(source?: string): boolean`

Potential home:
- `src/runtime/host/message-handler/services/reply-finalizer.ts`
- or a nearby host utility file

#### Initial source set
Start with the sources already proven by code:
- `heartbeat`
- `heartbeat-wake`
- `detached-run-announce`
- `watchdog`

Only add more sources when there is an actual inbound execution-flow path using them.

#### Tests required
- `execution-flow.test.ts`: each classified internal source suppresses `NO_REPLY` when pending lifecycle work exists

---

### Fix R4 — rename / clarify lifecycle guard semantics

**Priority: medium-low**

#### Goal
Reduce confusion between “pending acknowledgement” and the broader current policy.

#### Current mismatch
- `checkSilentReplyAllowed()` sounds ack-only
- `getPendingUserVisibleAck()` also gates on undelivered terminal delivery

#### Recommendation
Do one of:
1. rename helpers to reflect current semantics, e.g. `checkSilentReplyAllowedForPendingLifecycleDelivery`
2. or keep names but update comments/docs/tests to explicitly say terminal undelivered runs also block silence

This is mostly a maintainability fix, not a user-facing fix.

---

## Recommended execution order

1. **R1 — terminal reply fallback from assistant message**
   - directly addresses the live `(no response)` symptom
2. **R2 — pre-dispatch empty-reply handling**
   - prevents empty text from surfacing when R1 still yields no visible text
3. **R3 — centralize internal source classification**
   - reduces regression risk
4. **R4 — rename/clarify lifecycle guard semantics**
   - cleanup/documentation alignment

---

## Validation

### Required
- `pnpm run check`
- `pnpm run test`
- `npx tsc --noEmit`

### Focused tests
- `src/runtime/host/message-handler/flow/execution-flow.test.ts`
- any prompt-runner / coordinator tests needed by the new terminal-text fallback contract
- optional regression test in `src/runtime/host/message-handler.test.ts` asserting `(no response)` does not appear for the recovered-terminal-text case

### Runtime verification
Re-run the previously failing scenario and verify logs show one of:
- a recovered terminal reply source (preferred), or
- a deterministic background-task fallback,

and **never**:
- `Terminal reply decision` with `terminalSource: "none"` followed by user-visible `(no response)`

---

## Non-goals

- Reworking the detached-run lifecycle architecture
- Removing `reply-dispatcher`'s hard fallback in the same change
- Broadly changing user-turn lifecycle guard policy
- Refactoring watchdog / heartbeat routing beyond the already-landed triage work
