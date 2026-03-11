# Async Task Lifecycle Implementation Guide

## Overview
This guide defines how to implement the async task lifecycle contract described in `devDocs/spec/async-task-lifecycle.md`. The main design decision is to treat async work as a first-class managed runtime task with authoritative lifecycle and delivery state, rather than as a fire-and-forget side effect of spawn, detached execution, or internal announce injection.

The runtime should separate three concerns that are currently entangled:
- lifecycle truth
- delivery guarantee
- optional conversational summarization

Delivery correctness must be enforced at the runtime layer even when prompt-level summarize paths return `NO_REPLY`, fail, or are skipped.

## Architecture Overview
### Core model
- Async work is represented as a managed task/run with explicit lifecycle state.
- One authoritative registry owns lifecycle state, visibility policy, and delivery bookkeeping.
- Delivery services consume registry state and perform guaranteed acknowledgement / terminal dispatch.
- Conversational summarize flows remain optional overlays that can improve wording but cannot be the only delivery path.

### Recommended high-level flow
1. Parent turn accepts detached or spawned async work.
2. Parent flow creates or updates authoritative task state with visibility policy and origin metadata.
3. Runtime ensures either:
   - immediate acknowledgement is directly dispatched, or
   - a guaranteed acknowledgement job is durably reserved before the parent turn can end.
4. Execution updates lifecycle state through `started`, optional `streaming`, and a terminal phase.
5. Terminal state schedules direct delivery and optional summarize enrichment.
6. Delivery state records send, retry, replay, dedupe, and terminal evidence.
7. Restart reconciliation restores pending notices and resolves orphaned live runs deterministically.

## Recommended Module Boundaries
### 1. Lifecycle / registry
Responsibility:
- authoritative task identity
- lifecycle transitions
- visibility policy resolution
- persistence serialization
- delivery-state bookkeeping hooks
- dedupe markers per phase

Likely home:
- extend `src/runtime/host/sessions/subagent-registry.ts`
- add `src/runtime/host/sessions/async-task-lifecycle.ts`

### 2. Delivery / announce service
Responsibility:
- guaranteed acknowledgement dispatch
- guaranteed terminal dispatch
- retry / backoff / replay scheduling
- delivery evidence recording
- optional summarize integration layered after guarantee path is established

Likely home:
- extend `src/runtime/host/sessions/subagent-announce.ts`
- add `src/runtime/host/sessions/async-task-delivery.ts`
- integrate with `src/runtime/host/message-handler/services/reply-dispatcher.ts`

### 3. Parent-turn enforcement / execution-flow integration
Responsibility:
- detect when current turn accepted user-visible detached work
- prevent silent parent completion with `NO_REPLY`
- enforce runtime acknowledgement scheduling before final turn suppression
- keep prompt silence available for truly internal flows only

Likely home:
- `src/runtime/host/message-handler/flow/execution-flow.ts`
- `src/runtime/host/sessions/spawn.ts`
- `src/runtime/subagent-registry.ts`
- `src/runtime/host/reply-utils.ts`
- `src/runtime/agent-manager/prompt-builder.ts`

### 4. Recovery / replay logic
Responsibility:
- restore persisted async task records on startup
- replay undelivered acceptance / terminal notices
- fail or abort orphaned in-progress tasks deterministically when host restart invalidates live execution
- preserve dedupe state across restart

Likely home:
- `src/runtime/host/sessions/subagent-registry.ts`
- host bootstrap / startup reconciliation paths

## Data Model Additions
Each authoritative async task record should carry enough metadata to separate lifecycle truth from delivery state.

Recommended fields:
```ts
interface AsyncTaskRecord {
  id: string;
  runId: string;
  parentSessionKey?: string;
  originSessionKey?: string;
  originMessageId?: string;
  originChannelId?: string;
  originPeerId?: string;
  originThreadId?: string;
  visibilityPolicy: "user_visible" | "internal_silent";
  lifecyclePhase: "accepted" | "started" | "streaming" | "completed" | "failed" | "timeout" | "aborted";
  ackDelivery: DeliveryPhaseState;
  terminalDelivery: DeliveryPhaseState;
  lastDeliveredPhase?: "accepted" | "completed" | "failed" | "timeout" | "aborted";
  retryCount: number;
  nextRetryAt?: number;
  lastDeliveryError?: string;
  dedupeKey?: string;
  acceptedAt: number;
  startedAt?: number;
  terminalAt?: number;
  terminalSummary?: string;
}

interface DeliveryPhaseState {
  status: "pending" | "queued" | "sending" | "delivered" | "failed";
  deliveryEvidenceId?: string;
  queuedAt?: number;
  deliveredAt?: number;
  attemptCount: number;
  lastError?: string;
}
```

Additional notes:
- Store origin session/message/channel metadata needed to reach the user even if the parent turn is gone.
- Persist explicit visibility policy rather than inferring it later from prompt behavior.
- Keep separate acknowledgement and terminal delivery state so partial lifecycle success is observable.
- Persist dedupe markers or last-delivered phase so replay stays idempotent.

## State Transition Rules
### Lifecycle transitions
Allowed normal flow:
- `accepted -> started`
- `started -> streaming`
- `started -> completed | failed | timeout | aborted`
- `streaming -> completed | failed | timeout | aborted`

Rules:
- terminal phases are one-way
- duplicate phase updates should be deduped
- out-of-order terminal updates must be rejected or normalized explicitly
- delivery bookkeeping must be tied to lifecycle transitions, not inferred from prompt output

### Delivery transitions
For both acknowledgement and terminal delivery:
- `pending -> queued -> sending -> delivered`
- `pending | queued | sending -> failed`
- `failed -> queued` on retry

Rules:
- `delivered` requires concrete evidence such as outbound dispatch result or persisted send token
- summarize success alone cannot transition delivery to `delivered`
- retries must preserve phase idempotence

## Delivery Strategy
### Required guarantee path
Use a guaranteed runtime delivery path for:
- acceptance acknowledgement
- terminal completion/failure/timeout/abort notices

This path should:
- bypass reliance on internal-message summarization
- dispatch directly through runtime delivery plumbing
- persist queued work if immediate dispatch is unavailable
- record delivery evidence on success

### Optional summarize path
Conversational summarization can still exist, but only as a secondary layer.
Recommended behavior:
- direct runtime acknowledgement may be simple and deterministic
- terminal delivery may include either:
  - a guaranteed runtime fallback message, or
  - a summarize-generated message if available
- if summarize generation fails or returns `NO_REPLY`, send the fallback runtime message and preserve delivery correctness

### Fallback queue / retry path
If direct dispatch cannot complete immediately:
- persist pending delivery work in the authoritative registry
- schedule retry with bounded backoff
- replay pending work on restart
- keep enough metadata to avoid losing the task's delivery obligation

## Parent-turn Behavior
When detached work is accepted and marked `user_visible`, execution flow must guarantee one of the following before the parent turn ends:
1. explicit immediate acknowledgement has already been sent, or
2. a runtime-reserved guaranteed acknowledgement path has been durably scheduled

Parent-turn rule:
- a parent turn must not silently finish with `NO_REPLY` after accepting user-visible detached work unless condition 2 is satisfied and persisted.

Implementation implications:
- `spawn.ts` should surface whether a spawned task is user-visible and whether acknowledgement is already satisfied.
- `execution-flow.ts` should inspect that state before allowing final suppression.
- `reply-utils.ts` and related helpers should expose a lifecycle-aware suppression guard.

## Prompt Contract Changes
### Keep prompt behavior narrow
`NO_REPLY` should remain available for truly silent/internal cases.

### Add runtime guardrails
The runtime must override prompt silence when silence would violate lifecycle guarantees.

Recommended contract:
- prompt builder may continue documenting `NO_REPLY`
- runtime-level enforcement decides whether silence is actually legal based on accepted async task state
- prompt-layer summarize/injection logic must not be treated as authoritative delivery completion

## Persistence and Recovery
### Persistence requirements
Persist:
- in-flight tasks
- visibility policy
- acknowledgement delivery state
- terminal delivery state
- retry metadata
- dedupe / last-delivered markers
- origin delivery metadata

### Startup reconciliation
On host bootstrap:
1. load persisted async task records
2. identify tasks with pending acknowledgement or terminal delivery
3. replay those notices through the delivery service
4. identify tasks marked in-progress/started/streaming whose live execution cannot continue
5. deterministically transition orphaned tasks to `aborted` or `failed`
6. enqueue terminal delivery for those reconciled tasks

### Replay semantics
- replay must be phase-aware and dedupe-aware
- terminal notices should be retried until delivered or explicitly marked permanently failed by policy
- delivery evidence must survive restart

## Tradeoffs and Rationale
### Why not rely on internal announce injection?
Because it is a presentation path, not a guarantee boundary. It can return `NO_REPLY`, fail to summarize, or be lost when the parent turn/session is unavailable.

### Why separate lifecycle truth from delivery state?
Because a task can finish execution while still owing a user-visible result. Conflating terminal lifecycle with delivered lifecycle caused the current black-hole risk.

### Why prefer correctness over elegance?
A plain runtime-generated acknowledgement is better than a silent task. Conversational polish can be layered on later, but runtime correctness must come first.

### Why centralize in an authoritative registry?
Detached execution spans spawn, execution, announce, dispatch, and recovery. One owner is needed for state transitions, persistence, and replay.

## Migration Sequence
1. Define lifecycle contract and implementation guide.
2. Refactor current detached-run registry into authoritative async lifecycle state owner.
3. Add guaranteed runtime delivery path for acceptance and terminal notices.
4. Wire parent-turn and prompt suppression guards so accepted user-visible tasks cannot black-hole.
5. Add recovery/replay semantics and regression coverage.

## Concrete File Targets
Primary existing targets:
- `src/runtime/host/sessions/spawn.ts`
- `src/runtime/host/sessions/subagent-registry.ts`
- `src/runtime/host/sessions/subagent-announce.ts`
- `src/runtime/host/message-handler/flow/execution-flow.ts`
- `src/runtime/host/message-handler/services/reply-dispatcher.ts`
- `src/runtime/agent-manager/prompt-builder.ts`
- `src/runtime/host/reply-utils.ts`
- `src/runtime/subagent-registry.ts`

Likely new modules:
- `src/runtime/host/sessions/async-task-lifecycle.ts`
- `src/runtime/host/sessions/async-task-delivery.ts`

## Validation Plan
### Unit-level
- lifecycle state transitions
- accepted/started/streaming/terminal dedupe behavior
- persisted delivery metadata serialization and restore
- replay and orphan handling after restart

### Integration-level
- inbound user message triggers detached task and visible acknowledgement
- detached task terminal outcome produces visible completion/failure delivery
- summarize path returning `NO_REPLY` does not suppress guaranteed delivery
- parent turn cannot black-hole after accepted user-visible spawn

### End-to-end/runtime observation
- logs show accepted/start/terminal transitions with matching delivery evidence
- no accepted user-visible task reaches terminal state without outbound send evidence or queued retry evidence

### Final validation commands
- `pnpm run check`
- `pnpm run test`
- targeted runtime tests for host/session/message-handler areas during implementation
