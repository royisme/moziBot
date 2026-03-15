# Architecture Review: Two-Tier Watchdog + Unified Event Queue

**Reviewer:** Claude Sonnet 4.6
**Date:** 2026-03-14
**Spec:** `devDocs/spec/watchdog-event-queue-arch.md`
**Verdict:** Approve with conditions (see blocking items)

---

## 1. Architecture Correctness

### Problem A — Subagent results bypass the queue

The spec correctly identifies the bypass. However, the spec's description of "current (broken)" code does not match actual code. In the real codebase, `SubagentRegistry.spawn()` does NOT call `handleInternalMessage()` directly from `onTerminal`. Looking at `src/runtime/subagent-registry.ts:208-219`, the `onTerminal` callback only calls `detachedRunRegistry.completeByChildKey()` and `decActive()`. The `handleInternalMessage()` call described in the spec's "Current (broken)" snippet does not exist in the present codebase.

**Implication:** The race condition (Problem A) may be partially mitigated already, but `handleInternalMessage` IS still called in-process from `RunLifecycleRegistry.onTerminal` at `message-handler.ts:135-148`. This deferred-message path is the real bypass, and it processes deferred messages synchronously without going through the queue. The spec's framing is directionally correct but the precise code path it cites is wrong.

**Logical gap:** The spec proposes routing `onTerminal` through `runtimeKernel.enqueueEvent()`, but `SubagentRegistry` does not hold a reference to `RuntimeKernel`. The current dependency graph is:

```
RuntimeHost → RuntimeKernel + MessageHandler
MessageHandler → SubagentRegistry
SubagentRegistry → HostSubagentRuntime (MessageHandler-provided)
```

`SubagentRegistry` would need a new dependency on the kernel's enqueue interface, or `HostSubagentRuntime` would need to expose an `enqueueEvent` method that is wired through `MessageHandler`. The spec does not address this wiring.

### Problem B — Spawn backpressure

The spec's solution is sound: replace `throw` with a `spawnQueue`. The proposed `PendingSpawnRequest` with `resolve`/`reject` handles the promise-based caller correctly. Minor issue: the spec does not specify what happens to queued spawn requests on process restart — they are still in-memory and lost, which may be acceptable if subagent spawns are always initiated by the parent agent's live context.

### Problem C — Proactive polling cost

The watchdog design is conceptually correct and eliminates idle LLM calls. The rule-based classifier at §3.4.1 handles >90% of real use cases for zero cost. The design is sound.

**Important gap:** The spec says "Watchdog replaces heartbeat runner." But the current `HeartbeatRunner` (`src/runtime/host/heartbeat.ts`) does more than scheduling: it reads `HEARTBEAT.md` for directives, collects `SystemEventEntries`, builds a prompt, checks session active state, and enqueues via `enqueueInbound`. The WatchdogService spec does not describe how `HEARTBEAT.md` file-based directives (enabled/disabled, interval overrides, custom prompts) are preserved post-migration. This is a user-facing feature that must not silently disappear.

---

## 2. Migration Risk Assessment

### Phase 1: Fix subagent result routing

**Actual risk: Medium (not Low as stated).** The spec assumes routing `onTerminal → runtimeQueue.enqueue()` is a simple substitution. In practice:

- `SubagentRegistry` must acquire a reference to an enqueue interface it doesn't currently have (see wiring gap above).
- The `pendingInternalMessages` Map migration requires that `handleInternalMessage` callers be updated atomically. The existing `RunLifecycleRegistry.onTerminal` handler at `message-handler.ts:135-148` reads from and drains `pendingInternalMessages` synchronously — if the map is removed while the lifecycle system still expects to drain it, pending deferred messages will be silently dropped.
- The spec says "keep the method but have it enqueue" (Open Question 5), which is the correct approach. But enqueuing creates a new queue item for the same `session_key`, which will be processed in order. Whether `handleInternalMessage` callers expect synchronous or async-deferred semantics matters for correctness. Specifically, `message-handler.ts:140` calls `handleInternalMessage` immediately after a run terminal — if this now enqueues asynchronously, there is a window where the session could be marked idle, a new user message could be picked up and dispatched, and THEN the internal message arrives. The queue ordering by insertion time handles this correctly only if the internal message is enqueued before the session lock is released.

### Phase 2: Subagent spawn backpressure

**Risk: Low.** Purely additive. The `spawnQueue` drain in `onSubagentTerminated` needs careful handling: it must call `drainSpawnQueue` AFTER `decActive` to avoid over-counting against the concurrency limit.

### Phase 3: Watchdog service

**Risk: Medium.** Config schema change requires documenting the transition. The `WatchdogStateCollector` referenced in Open Question 3 needs aggregating state from `RunLifecycleRegistry`, `AgentJobRegistry`, and cron store — none of which have a unified read interface today.

**Specific risk:** `HeartbeatRunner` currently has `setPaused`/`isPaused` methods that callers may depend on. The spec does not mention preserving this control surface.

### Phase 4: Deprecate callback-based heartbeat

**Risk: Medium-High.** This is the phase where `pendingInternalMessages`, direct `handleInternalMessage()` calls from lifecycle callbacks, and `HeartbeatRunner` are removed. Any call site missed during the Phase 1-3 migration will silently break here. A code-search-and-replace approach (grep for all `handleInternalMessage` callers) should be done before this phase is approved. At time of review, callers are limited to `message-handler.ts:140` (lifecycle deferred drain) and the method's own body — the surface is small but the consequence of a miss is silent message loss.

---

## 3. Open Questions Assessment

### Blocking (must resolve before implementation starts)

**Q1 — Context for `subagent_result` events:** Blocking. The current subagent result flow calls `runPromptWithFallback()` while the parent agent's in-memory `AgentManager` state is warm (session loaded, model known). A queued `subagent_result` processed later must reconstruct this context. `processQueueItem` at `queue-item-processor.ts:85` calls `parseInbound(queueItem.inbound_json)` — the `subagent_result` payload must carry enough information (agentId, sessionKey, runId, result text) for the pump to re-hydrate context without relying on in-memory state that may have been evicted.

**Q3 — Watchdog state gathering:** Blocking. The `WatchdogStateCollector` is central to the rule classifier. Without defining what interfaces it reads from (and confirming those interfaces are accessible without coupling to internal state), the watchdog cannot be implemented. This requires at minimum: a read-only view of `RunLifecycleRegistry`, the cron scheduler's next-fire times, the reminder store, and the memory governance clock.

**Q5 — Backward compatibility for `handleInternalMessage()`:** Blocking for Phase 1. The migration strategy of "keep the method but have it enqueue" is correct, but the exact enqueue semantics (which `session_key`, what `event_type`, what priority) must be specified so the queue processor can route it correctly. Without this, Phase 1 cannot be implemented correctly.

### Non-Blocking

**Q2 — Priority ordering:** Non-blocking. The default (`user_message = 0`, `watchdog_wake = 10`) stated in the spec is reasonable. This is a config-time decision and can be tuned after the queue schema is in place.

**Q4 — Local model integration:** Non-blocking. The rule-based classifier covers the default path. Local model adapter can be a separate follow-on task.

**Note:** The spec lists 7 open questions in the TOC but only 5 are written in §7. Questions 6 and 7 are missing. This should be remedied.

---

## 4. Missing Considerations

### Context window implications of queued subagent results

When a subagent result arrives via queue and is injected as a prompt into the parent agent, the parent agent's context window may have grown substantially since the subagent was spawned (e.g., user sent several messages in the interim). The injected result must not duplicate content already in the conversation. The spec does not address deduplication or context-aware injection of subagent results.

### Queue schema migration

The spec proposes extending `RuntimeQueueItem` with `event_type`, `priority`, and `scheduled_at`. The existing SQLite schema (inferred from `runtimeQueue.enqueue()` calls in `queue-item-processor.ts:492`) uses `inbound_json` as its payload field — typed to `InboundMessage`. The `subagent_result` payload is not an `InboundMessage`. Either:
- A new `payload` column is added alongside `inbound_json` for non-user-message events, or
- `inbound_json` is repurposed as a generic JSON blob (breaking its current TypeScript type contract).

The spec does not specify which approach, but the choice has significant impact on `processQueueItem`, which currently hard-codes `parseInbound(queueItem.inbound_json)` at `queue-item-processor.ts:85`.

### Test strategy

The spec has no test section. The following test scenarios are missing and should be specified before implementation:

- Subagent result enqueued while parent session has active run — verify ordering is preserved, result is processed after active run completes.
- Restart mid-subagent — verify enqueued `subagent_result` survives and is processed on startup.
- Concurrent user message + subagent result for same session — verify `user_message` wins (priority 0 < 1).
- `watchdog_wake` enqueued while session already has items — verify no duplicate LLM call.
- `pendingInternalMessages` migration: verify no messages are dropped at the boundary.

### Heartbeat.md directive compatibility

The existing `HeartbeatRunner` reads `HEARTBEAT.md` for `@heartbeat enabled`, `@heartbeat every`, and `@heartbeat prompt` directives at `heartbeat.ts:232-239`. These are user-facing controls. The WatchdogService must either replicate this file-based config protocol or provide a migration path. The spec does not mention it.

### `SystemEventEntries` fate

`heartbeat.ts:259-311` reads and drains `peekSystemEventEntries(sessionKey)` during heartbeat runs. This is a separate in-memory event store that feeds the heartbeat prompt. The spec does not mention what happens to it under the new architecture. If `WatchdogService` replaces `HeartbeatRunner`, this mechanism needs to be either preserved or replaced by the unified queue.

### `spawnQueue` per-session vs global

The spec shows a single `spawnQueue: PendingSpawnRequest[]` in `SubagentRegistry`. With per-session concurrency limits (`MAX_CONCURRENT_SUBAGENTS` is per `sessionKey`), a global spawn queue will process requests in FIFO order regardless of session. If session A fills its limit and session B has a spawn waiting, session B's spawn is blocked behind session A's drain. The queue should be per-sessionKey or drain should check across all sessions.

---

## 5. Specific Code Concerns

### `SubagentRegistry` has no kernel reference (critical)

`src/runtime/subagent-registry.ts:65-70`: The constructor takes `ModelRegistry`, `ProviderRegistry`, `AgentManager`, and an optional `HostSubagentRuntime`. It has no path to enqueue into `RuntimeKernel`. The spec's Phase 1 target code (`runtimeKernel.enqueueEvent(...)`) requires a new injection point. This is not mentioned in the "Files Affected" section.

### `processQueueItem` type-dispatch hardcoded to `InboundMessage`

`src/runtime/core/kernel/queue-item-processor.ts:85`: `params.parseInbound(params.queueItem.inbound_json)` is called unconditionally on every queue item. Routing `subagent_result` and `watchdog_wake` events through this pump requires either:
- Early return / type dispatch before `parseInbound` is called, or
- `inbound_json` carrying a discriminated union that `parseInbound` handles.

The spec proposes adding event type routing to the pump loop (§8, "Modified files: `src/runtime/core/kernel/*.ts`") but does not detail this dispatch logic.

### `HeartbeatRunner` is deeply coupled to `MessageHandler`

`src/runtime/host/heartbeat.ts:43-46`: `HeartbeatRunner` constructor takes `MessageHandler` directly and calls `handler.getLastRoute()`, `handler.resolveSessionContext()`, `handler.isSessionActive()`. Replacing it with `WatchdogService` means either:
- `WatchdogService` gets the same `MessageHandler` dependency (tightly coupled, inconsistent with the "pure event producer" design in the spec), or
- The interfaces `WatchdogStateCollector` needs (`getLastRoute`, session active status) are extracted into a separate read-only facade.

The spec diagram shows the watchdog as "standalone" but the current heartbeat implementation is not standalone — it touches `MessageHandler` internals. This coupling needs an explicit break plan.

### `runtimeKernel` recreated on each `reloadMessageHandler`

`src/runtime/host/index.ts:314`: `this.runtimeKernel = new RuntimeKernel(...)` is called inside `reloadMessageHandler`. If `WatchdogService` holds a reference to the kernel for enqueueing, it must be updated when the kernel is recreated, or the kernel must be accessed via a stable reference (a getter/callback pattern). This is a latent bug in the current design that becomes critical when the watchdog needs to enqueue.

---

## 6. Recommendation

**Approve with conditions.**

The architecture direction is correct and the problems it solves are real. However, three items must be resolved before implementation begins:

**Condition 1:** Resolve the kernel reference injection gap. Specify how `SubagentRegistry` and `WatchdogService` acquire an enqueue interface into `RuntimeKernel` without creating circular dependencies. The most defensible approach is to extract a narrow `EventEnqueuer` interface from `RuntimeKernel` and pass it through `HostSubagentRuntime`.

**Condition 2:** Specify the queue schema extension precisely. Define whether `inbound_json` is repurposed as a generic payload blob or whether a separate `event_payload` column is added. This decision gates the `processQueueItem` dispatch rewrite.

**Condition 3:** Document the `HEARTBEAT.md` directive and `SystemEventEntries` migration path so user-visible behavior is not silently lost in Phase 4.

The phase ordering (1 → 4) is safe if Condition 1 and 2 are resolved first. Phase 1 is the highest-value, lowest-risk change and should be scoped as a standalone PR with explicit tests for the ordering guarantee.
