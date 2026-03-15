# Architecture Spec: Two-Tier Watchdog + Unified Event Queue

**Status:** Revised (post-review)
**Date:** 2026-03-14
**Review:** `devDocs/spec/watchdog-event-queue-arch-review.md`

---

## 1. Problem Statement

### 1.1 Current Architecture Deficiencies

**Problem D: HeartbeatRunner is deeply coupled to MessageHandler**

`HeartbeatRunner` constructor takes `MessageHandler` directly and calls three of its methods:
- `handler.getLastRoute(agentId)` — last channel/peer/route for an agent
- `handler.resolveSessionContext(fakeInboundMessage)` — converts a route back to a sessionKey
  (HeartbeatRunner constructs a fake `InboundMessage` purely to call this method)
- `handler.isSessionActive(sessionKey)` — whether a session is currently processing

This creates a hard circular boundary: `RuntimeHost → HeartbeatRunner → MessageHandler`,
while `MessageHandler` manages agents and sessions that are conceptually separate from
heartbeat scheduling. The WatchdogService that replaces HeartbeatRunner must not carry
this coupling forward.

**Problem A: Subagent results bypass the queue**

When a subagent finishes, `RunLifecycleRegistry.onTerminal` at `message-handler.ts:135-148`
reads from and drains `pendingInternalMessages` synchronously — calling `runPromptWithFallback()`
directly without going through `RuntimeKernel`'s SQLite queue. This means:
- Subagent result + concurrent user message can race (no ordering guarantee)
- `pendingInternalMessages` is an in-memory Map — lost on restart
- No retry, no backpressure, no priority control

> Note: `SubagentRegistry.onTerminal` itself only calls `detachedRunRegistry.completeByChildKey()`
> and `decActive()`. The real queue bypass is in the lifecycle drain at message-handler.ts:135-148.

**Problem B: Subagent concurrency limit throws instead of queuing**

`SubagentRegistry.incActive()` throws `"Subagent concurrency limit reached"` when
`MAX_CONCURRENT_SUBAGENTS = 2` is exceeded. The correct behavior is backpressure (enqueue spawn
request and drain when a slot opens), not rejection.

**Problem C: Proactive agent behavior requires expensive LLM polling**

OpenClaw's heartbeat model calls the full LLM on every timer tick to ask "do you have anything to say?"
This costs ~$6–130/month at idle depending on model tier. The `HEARTBEAT_OK` token suppresses
output but the inference is already paid. The LLM should not be the sensor — it should only be
the actor.

### 1.2 Design Intent

> "Subagent should be like a Kafka queue. Main agent is event-driven — only called when there
> is real work. Proactive sensing should use a lightweight watchdog or local model to decide
> whether to wake the main agent. Main LLM cost at idle should be zero."

---

## 2. Target Architecture

### 2.1 Overview

```
┌──────────────────────────────────────────────────────────┐
│                     Event Sources                         │
│  User message │ Subagent result │ Cron │ Reminder │ … │
└──────────────┬───────────────────────────────────────────┘
               │  all events produce queue messages
               ▼
┌──────────────────────────────────────────────────────────┐
│             Unified Event Queue (SQLite)                  │
│  event_type: user_message | subagent_result | cron_fire   │
│              reminder | internal | watchdog_wake          │
│  Per-session ordering, retry, backpressure                │
└──────────────┬───────────────────────────────────────────┘
               │
               ▼
┌──────────────────────────────────────────────────────────┐
│           RuntimeKernel pump loop (existing)              │
│  Dequeues → type-dispatch → MessageHandler                │
└──────────────┬───────────────────────────────────────────┘
               │
               ▼
┌──────────────────────────────────────────────────────────┐
│           Main Agent (LLM call)                           │
│  Only called when there is real work in the queue         │
└──────────────────────────────────────────────────────────┘

     ┌───────────────────────────────────────────────┐
     │         Watchdog Layer (separate process)      │
     │                                                │
     │  Timer fires (configurable interval)           │
     │       ↓                                        │
     │  WatchdogClassifier.evaluate(state)            │
     │   [rules engine | local model | api model]     │
     │       ↓ only if decision == "wake"             │
     │  EventEnqueuer.enqueue(watchdog_wake)           │
     └───────────────────────────────────────────────┘
```

### 2.2 Key Principles

1. **Queue-first**: Every trigger that may cause a main agent LLM call goes through the unified queue.
2. **Sensing ≠ Acting**: Watchdog decides IF the agent should act; the queue decides WHEN; the LLM acts.
3. **No synchronous bypass**: `handleInternalMessage()` enqueues rather than calling `runPromptWithFallback()` directly.
4. **Pluggable classifier**: Watchdog classifier is swappable (rules / local model / API model) via config.
5. **Zero idle LLM cost**: When the queue is empty, the LLM is never called.

---

## 3. Component Design

### 3.1 EventEnqueuer Interface (new narrow interface)

To avoid circular dependencies (`SubagentRegistry` → `RuntimeKernel` → `MessageHandler` →
`SubagentRegistry`), extract a narrow enqueue interface:

```typescript
// src/runtime/core/contracts.ts (add)
export interface EventEnqueuer {
  enqueueEvent(params: {
    sessionKey: string;
    eventType: EventType;
    payload: Record<string, unknown>;
    priority?: number;
    scheduledAt?: Date;
  }): Promise<void>;
}
```

**Wiring:**

```
RuntimeKernel implements EventEnqueuer
    ↓ passed into
HostSubagentRuntime (new field: enqueuer: EventEnqueuer)
    ↓ passed into
SubagentRegistry.hostRuntime.enqueuer
    ↓ used by
SubagentRegistry (onTerminal result routing)

RuntimeKernel implements EventEnqueuer
    ↓ passed into
WatchdogService (constructor: enqueuer: EventEnqueuer)
```

**RuntimeKernel recreation stability:**
`RuntimeHost.reloadMessageHandler()` recreates `RuntimeKernel`. Any service holding an `EventEnqueuer`
reference must be updated on reload. Use an indirection wrapper:

```typescript
// src/runtime/core/enqueuer-ref.ts
export class EventEnqueuerRef implements EventEnqueuer {
  private current: EventEnqueuer;
  constructor(initial: EventEnqueuer) { this.current = initial; }
  setTarget(next: EventEnqueuer) { this.current = next; }
  enqueueEvent(params) { return this.current.enqueueEvent(params); }
}
```

`RuntimeHost` holds one `EventEnqueuerRef`, passes it to `WatchdogService` and
`HostSubagentRuntime`. On `reloadMessageHandler`, calls `enqueuerRef.setTarget(newKernel)`.

### 3.2 Queue Schema Extension

**Decision: separate `event_payload` column alongside existing `inbound_json`.**

Rationale: `inbound_json` is typed to `InboundMessage`. Repurposing it as a generic blob
breaks the TypeScript contract and the `parseInbound()` call in `queue-item-processor.ts:85`.
A separate column preserves backward compatibility.

```sql
ALTER TABLE runtime_queue ADD COLUMN event_type TEXT NOT NULL DEFAULT 'user_message';
ALTER TABLE runtime_queue ADD COLUMN event_payload TEXT;    -- JSON, for non-user-message events
ALTER TABLE runtime_queue ADD COLUMN priority INTEGER NOT NULL DEFAULT 0;
ALTER TABLE runtime_queue ADD COLUMN scheduled_at TEXT;    -- ISO8601, for cron/reminder events
```

**Default priority values:**

| event_type | priority |
|-----------|---------|
| `user_message` | 0 |
| `subagent_result` | 1 |
| `internal` | 2 |
| `cron_fire` | 5 |
| `reminder` | 5 |
| `watchdog_wake` | 10 |

User messages always preempt background events within the same session.

### 3.3 pump loop type dispatch

`queue-item-processor.ts:85` calls `parseInbound(queueItem.inbound_json)` unconditionally.
Add a type dispatch before this point:

```typescript
// queue-item-processor.ts
if (params.queueItem.event_type !== "user_message") {
  await handleNonUserEvent({
    queueItem: params.queueItem,
    messageHandler: params.messageHandler,
    sessionManager: params.sessionManager,
    schedulePump: params.schedulePump,
    releaseSession: params.releaseSession,
  });
  return;
}
// existing InboundMessage path continues unchanged
const inbound = params.parseInbound(params.queueItem.inbound_json);
```

`handleNonUserEvent` routes by `event_type` and calls the appropriate handler on `MessageHandler`.

### 3.4 Subagent Result Routing Fix

**Real bypass location (corrected from first draft):**
`message-handler.ts:135-148` — `RunLifecycleRegistry.onTerminal` drains `pendingInternalMessages`
synchronously after a run completes.

**Target: enqueue instead of drain synchronously:**

```typescript
// message-handler.ts — replace synchronous drain:
// BEFORE:
const deferred = this.pendingInternalMessages.get(sessionKey) ?? [];
this.pendingInternalMessages.delete(sessionKey);
for (const msg of deferred) {
  await this.runPromptWithFallback({ sessionKey, agentId, text: msg.content, ... });
}

// AFTER:
const deferred = this.pendingInternalMessages.get(sessionKey) ?? [];
this.pendingInternalMessages.delete(sessionKey);
for (const msg of deferred) {
  await this.enqueuer.enqueueEvent({
    sessionKey,
    eventType: "internal",
    payload: { content: msg.content, source: msg.source, metadata: msg.metadata },
    priority: 2,
  });
}
```

**Ordering safety:** The enqueue must happen before `releaseSession()` in the pump loop so the
internal message enters the queue while the session lock still gates new processing. The pump
will pick it up in the next cycle, after the current run is fully committed.

**Backward compatibility for `handleInternalMessage()`:**
Keep the public method signature intact. Change its body to call `enqueueEvent` instead of
`runPromptWithFallback` directly. All existing callers (memory maintainer hooks, exec
completion signals) continue to work — they just get async delivery instead of synchronous.

### 3.5 `subagent_result` Context Re-hydration

When a `subagent_result` event is processed by the pump, the parent agent's in-memory
`AgentManager` state may have been evicted (e.g., after a restart). The payload must carry
enough information to re-hydrate:

```typescript
type SubagentResultPayload = {
  parentSessionKey: string;
  parentAgentId: string;
  runId: string;
  childSessionKey: string;
  terminal: "completed" | "timeout" | "aborted" | "failed";
  resultText?: string;      // final assistant text from child session
  error?: string;
  visibilityPolicy: "user_visible" | "internal_silent";
};
```

`handleNonUserEvent` for `subagent_result` calls:
```typescript
await messageHandler.handleSubagentResult(payload);
```
…which reloads context from the session store if needed (same pattern as `runPromptWithFallback`
with session reload).

**Context window deduplication:** The injected result text must not duplicate content already
present in the parent session's conversation. The `buildSubagentResultSummary()` output should
be idempotent — if the parent agent already has the result in its transcript, the injection is
skipped.

### 3.6 Subagent Spawn Backpressure

**Per-session spawn queue** (not global — avoids cross-session blocking):

```typescript
// SubagentRegistry
private spawnQueues = new Map<string, PendingSpawnRequest[]>();

async spawn(params: SubagentRunParams): Promise<SubagentSpawnResult> {
  if (this.getActiveCount(params.parentSessionKey) >= MAX_CONCURRENT_SUBAGENTS) {
    return new Promise((resolve, reject) => {
      const queue = this.spawnQueues.get(params.parentSessionKey) ?? [];
      queue.push({ params, enqueuedAt: Date.now(), resolve, reject });
      this.spawnQueues.set(params.parentSessionKey, queue);
    });
  }
  return this.doSpawn(params);
}

private onSubagentTerminated(parentSessionKey: string) {
  this.decActive(parentSessionKey);         // decrement FIRST
  this.drainSpawnQueue(parentSessionKey);   // THEN drain
}

private drainSpawnQueue(sessionKey: string) {
  const queue = this.spawnQueues.get(sessionKey) ?? [];
  if (queue.length === 0) return;
  const next = queue.shift()!;
  this.spawnQueues.set(sessionKey, queue);
  this.doSpawn(next.params).then(next.resolve).catch(next.reject);
}
```

> Note: spawn queue is in-memory. Queued spawns are lost on restart, which is acceptable
> because they are always initiated by a live parent agent run context.

### 3.7 HeartbeatRunner → MessageHandler Decoupling

#### 3.7.1 Root cause analysis

The three coupled calls each have a correct home that is NOT `MessageHandler`:

| HeartbeatRunner call | Current source | Correct source |
|----------------------|---------------|----------------|
| `getLastRoute(agentId)` | `MessageHandler` | `AgentManager` already stores session context with route |
| `resolveSessionContext(fakeMsg)` | `MessageHandler` → `RuntimeRouter` | `RuntimeRouter` directly — pure routing function |
| `isSessionActive(sessionKey)` | `MessageHandler` → `activePromptRuns` | `RunLifecycleRegistry.hasActiveRun(sessionKey)` or `pumpState.activeSessions` |

`MessageHandler.getLastRoute` and `isSessionActive` are thin wrappers that read from
`AgentManager` and `RunLifecycleRegistry` respectively. `resolveSessionContext` delegates
to `RuntimeRouter`. HeartbeatRunner does not need the full `MessageHandler` — it needs
three narrow read operations on three different subsystems.

#### 3.7.2 WatchdogReadFacade (new interface)

Extract a narrow read-only interface that replaces the `MessageHandler` dependency:

```typescript
// src/runtime/watchdog/watchdog-read-facade.ts

import type { RouteContext } from "../host/routing/types";

export interface WatchdogReadFacade {
  /**
   * The last known route (channel/peer/peerType) for a given agentId.
   * Returns undefined if the agent has never handled a message.
   * Source: AgentManager.getSessionContext() across all sessions.
   */
  getLastRoute(agentId: string): RouteContext | undefined;

  /**
   * Resolve the canonical sessionKey for a given agentId + route combination.
   * Pure routing function — no side effects.
   * Source: RuntimeRouter.resolveSessionKeyFromRoute().
   */
  resolveSessionKey(agentId: string, route: RouteContext): string;

  /**
   * Whether the given session is currently processing a prompt run.
   * Source: RunLifecycleRegistry or pumpState.activeSessions.
   */
  isSessionActive(sessionKey: string): boolean;

  /**
   * Home directory for the agent (where HEARTBEAT.md lives).
   * Source: AgentManager.getHomeDir().
   */
  getHomeDir(agentId: string): string | undefined;
}
```

#### 3.7.3 Wiring in RuntimeHost

`RuntimeHost` constructs the facade from existing subsystems and passes it to
`WatchdogService` — no `MessageHandler` reference involved:

```typescript
// RuntimeHost.buildWatchdogFacade() — called after all subsystems are initialized
private buildWatchdogFacade(): WatchdogReadFacade {
  return {
    getLastRoute: (agentId) => {
      // AgentManager already tracks last route per session
      return this.messageHandler.getAgentManager().getLastRoute(agentId);
    },
    resolveSessionKey: (agentId, route) => {
      // Pure routing — RuntimeRouter already has this logic
      return this.runtimeRouter.resolveSessionKeyFromRoute(agentId, route);
    },
    isSessionActive: (sessionKey) => {
      // RunLifecycleRegistry is the authoritative source for active runs
      return this.runLifecycleRegistry.hasActiveRun(sessionKey);
    },
    getHomeDir: (agentId) => {
      return this.messageHandler.getAgentManager().getHomeDir(agentId);
    },
  };
}
```

> Note: `getLastRoute` and `getHomeDir` still delegate through `messageHandler.getAgentManager()`
> temporarily. In a future cleanup, `AgentManager` would be a direct dependency of `RuntimeHost`
> and these would reference it directly. For now, this is acceptable — the WatchdogService does
> NOT hold a `MessageHandler` reference, only the `WatchdogReadFacade`.

#### 3.7.4 RuntimeRouter.resolveSessionKeyFromRoute (new method)

Currently HeartbeatRunner builds a fake `InboundMessage` to call
`MessageHandler.resolveSessionContext()` which internally calls `RuntimeRouter`. This is
a roundabout path. Add a direct method to `RuntimeRouter`:

```typescript
// src/runtime/host/router.ts (add method)
resolveSessionKeyFromRoute(agentId: string, route: RouteContext): string {
  // Extract sessionKey derivation logic from resolveSessionContext
  // agentId + channel + peerId + dmScope → sessionKey
  return buildSessionKey({ agentId, route, dmScope: this.config.dmScope });
}
```

The sessionKey derivation logic already exists inside `resolveSessionContextService` —
this extracts it as a standalone pure function without requiring a full `InboundMessage`.

#### 3.7.5 RunLifecycleRegistry.hasActiveRun (new method or alias)

`MessageHandler.isSessionActive()` currently checks `this.activePromptRuns.has(sessionKey)`.
This should be on `RunLifecycleRegistry` instead:

```typescript
// src/runtime/host/message-handler/services/run-lifecycle-registry.ts (add)
hasActiveRun(sessionKey: string): boolean {
  const run = this.getRunBySession(sessionKey);
  return run !== undefined && run.state === "running";
}
```

`MessageHandler.isSessionActive()` becomes a thin delegate for backward compatibility:
```typescript
isSessionActive(sessionKey: string): boolean {
  return this.runLifecycle.hasActiveRun(sessionKey);
}
```

#### 3.7.6 Result: WatchdogService constructor

After decoupling, `WatchdogService` constructor takes only what it needs:

```typescript
// BEFORE (HeartbeatRunner):
constructor(
  private handler: MessageHandler,   // ← entire MessageHandler
  private agentManager: AgentManager,
  private enqueueInbound: (message: InboundMessage) => Promise<void>,
)

// AFTER (WatchdogService):
constructor(
  private facade: WatchdogReadFacade,      // ← narrow read-only interface
  private enqueuer: EventEnqueuer,          // ← narrow write interface
  private config: WatchdogConfig,
)
```

Zero `MessageHandler` dependency. Zero `InboundMessage` construction for routing purposes.

### 3.8 Watchdog Layer

#### 3.8.1 WatchdogStateCollector

The collector aggregates read-only state from existing registries.
It uses `WatchdogReadFacade` (§3.7.2) for session/routing state, plus separate
read interfaces for cron, reminder, and memory governance — zero `MessageHandler`
dependency:

```typescript
// src/runtime/watchdog/state-collector.ts
interface WatchdogStateInputs {
  facade: WatchdogReadFacade;                  // session + routing (§3.7.2)
  getCronEvents: () => CronEvent[];            // AgentJobRegistry
  getReminders: () => Reminder[];              // ReminderRunner
  isMemoryMaintenanceDue: () => boolean;       // MemoryGovernance lifecycle
  getPendingSubagentResultCount: () => number; // runtimeQueue.countByType("subagent_result")
}
```

`RuntimeHost` wires these inputs at startup from existing subsystems.

#### 3.8.2 Rule-based classifier (default, cost = $0)

```typescript
function evaluateRules(state: WatchdogState): "wake" | "sleep" {
  if (state.pendingCronEvents.length > 0) return "wake";
  if (state.pendingReminders.length > 0) return "wake";
  if (state.isMemoryMaintenanceDue) return "wake";
  if (state.pendingSubagentResultCount > 0) return "wake";
  return "sleep";
}
```

Covers >90% of proactive use cases for zero cost.

#### 3.8.3 Local model classifier (cost ≈ $0)

```
Model: Phi-3 mini / Llama 3.2 3B / Qwen 0.5B
Runtime: Ollama HTTP API (pluggable adapter)
Input: ~100 token state summary
Output: "wake" | "sleep"
Latency: 50–200ms on CPU
```

Enabled when rule engine is insufficient (e.g., ambient awareness, natural-language conditions).

#### 3.8.4 API model classifier (cost ~1/25 of full heartbeat)

```
Model: Gemini Flash / Claude Haiku
Input: minimal state summary (~200 tokens)
Output: binary decision
```

#### 3.8.5 HEARTBEAT.md compatibility

The existing `HeartbeatRunner` reads `HEARTBEAT.md` for `@heartbeat enabled`, `@heartbeat every`,
and `@heartbeat prompt` file-based directives. These are user-visible controls that must be preserved.

**Migration path:**
- `WatchdogService` reads the same `HEARTBEAT.md` format via a shared `HeartbeatDirectiveReader`
- The `@heartbeat prompt` directive maps to a `customWatchdogContext` field in `WatchdogState`,
  which is passed to model-based classifiers as additional context
- `@heartbeat every <interval>` sets `WatchdogConfig.intervalMs`
- `@heartbeat enabled false` disables the watchdog for that agent
- Backward-compatible: existing `HEARTBEAT.md` files continue to work without changes

#### 3.8.6 SystemEventEntries migration

`heartbeat.ts:259-311` drains `peekSystemEventEntries(sessionKey)` during heartbeat runs.
Under the new architecture:
- Events that are deterministic (cron fires, exec completions) are enqueued directly as queue
  items (`cron_fire`, `internal`) rather than going through `SystemEventEntries`
- `SystemEventEntries` is retained as an escape hatch for events that cannot be cleanly typed
  into the queue schema. The watchdog reads it as part of `WatchdogState` and may enqueue a
  `watchdog_wake` if entries are present
- Phase 4 deprecates `SystemEventEntries` after all event producers are migrated to queue items

#### 3.8.7 WatchdogService control surface

`HeartbeatRunner` has `stop()` / `updateConfig()` called by `RuntimeHost`. `WatchdogService`
exposes the same lifecycle contract:

```typescript
class WatchdogService {
  start(config: MoziConfig): void;
  stop(): void;
  updateConfig(config: MoziConfig): void;
  // Watchdog does NOT expose pause/resume — callers interact via queue priority, not pausing
}
```

---

## 4. Migration Strategy

### Phase 1: Fix internal message routing (Medium risk)

**Scope:**
- `handleInternalMessage()` enqueues `internal` queue item instead of calling `runPromptWithFallback` directly
- `pendingInternalMessages` Map drained into queue items at the enqueue point
- Add `event_type`, `event_payload`, `priority`, `scheduled_at` columns to SQLite schema
- Add `handleNonUserEvent` type dispatch in `processQueueItem` (early return for non-`user_message`)
- `EventEnqueuer` interface + `EventEnqueuerRef` wrapper added
- `RuntimeKernel` implements `EventEnqueuer`
- `HostSubagentRuntime` gains `enqueuer: EventEnqueuer` field

**Key ordering invariant:** Enqueue deferred messages before `releaseSession()` so the session
lock gates processing order. Verify with test: concurrent user message + deferred internal — internal is processed second.

**Risk mitigation:** Keep `handleInternalMessage()` signature identical. Add a feature flag
`ENABLE_QUEUE_INTERNAL_MESSAGES` to roll back to Map-based behavior if ordering issues emerge.

### Phase 2: Subagent result routing (Low risk)

**Scope:**
- `SubagentRegistry.hostRuntime` gains `enqueuer` field
- Route `onTerminal` → `enqueuer.enqueueEvent("subagent_result")` instead of lifecycle drain
- Add `SubagentResultPayload` type with context re-hydration fields
- `MessageHandler.handleSubagentResult()` added
- `handleNonUserEvent` routes `subagent_result` to `handleSubagentResult`

### Phase 3: Subagent spawn backpressure (Low risk)

**Scope:**
- `SubagentRegistry.spawnQueues` Map added (per-session)
- Replace `throw` with queue + drain on terminal
- `onSubagentTerminated` wired into existing `decActive` call path

### Phase 4: Watchdog service + HeartbeatRunner decoupling (Medium risk)

**Scope:**
- `RuntimeRouter.resolveSessionKeyFromRoute()` added (pure routing, no MessageHandler)
- `RunLifecycleRegistry.hasActiveRun()` added; `MessageHandler.isSessionActive()` delegates to it
- `WatchdogReadFacade` interface defined; `RuntimeHost.buildWatchdogFacade()` wires it from
  `AgentManager` + `RuntimeRouter` + `RunLifecycleRegistry` — zero `MessageHandler` reference
- `WatchdogService` class with rule-based classifier (default); constructor takes only
  `WatchdogReadFacade` + `EventEnqueuer` — no `MessageHandler`, no `InboundMessage` construction
- `WatchdogStateCollector` with `WatchdogStateInputs` wired in `RuntimeHost`
- `HeartbeatDirectiveReader` reads `HEARTBEAT.md` (shared with existing runner)
- `EventEnqueuerRef` passed to `WatchdogService` at construction
- `RuntimeHost` starts `WatchdogService` alongside (not yet replacing) `HeartbeatRunner`
- Config schema extended with `watchdog:` block
- Existing `heartbeat:` config keys map to `watchdog:` equivalents (backward-compatible aliases)
- Both runners active during transition; `HeartbeatRunner` gated behind feature flag

### Phase 5: Deprecate legacy paths (Medium-High risk)

**Scope (only after Phase 1-4 fully validated):**
- Remove `pendingInternalMessages` Map
- Remove synchronous `runPromptWithFallback` from `handleInternalMessage`
- Migrate `SystemEventEntries` producers to direct queue enqueue
- Deprecate `HeartbeatRunner` (keep for one release cycle, then remove)

**Pre-condition:** Run `grep -r "handleInternalMessage\|pendingInternalMessages" src/` and confirm
all callers are migrated. Zero silent message loss is the bar.

---

## 5. What Stays the Same

- `RuntimeKernel` pump loop — add type dispatch, existing user_message path unchanged
- `MessageHandler.handle()` — still the LLM dispatch entry point
- All channel adapters (Telegram, Discord, local desktop)
- Existing `RuntimeQueueMode` (followup / collect / interrupt / steer)
- `RunLifecycleRegistry` for tracking in-flight runs
- `HEARTBEAT.md` file format — backward-compatible
- `HeartbeatRunner.setPaused()/isPaused()` control surface — replicated in `WatchdogService`

---

## 6. Test Strategy

Required tests before each phase merges:

**Phase 1:**
- Deferred internal message enqueued before `releaseSession()` — processed in correct order
- `handleInternalMessage()` with active session → queues, does not call LLM immediately
- Restart mid-deferred-message → message survives and processes on startup

**Phase 2:**
- Subagent result enqueued while parent session has active run → processed after run completes
- Subagent result payload re-hydrates context correctly after session eviction
- Concurrent user message + subagent result → `user_message` (priority 0) wins
- `subagent_result` not duplicated if parent session already has result in transcript

**Phase 3:**
- Spawn at limit → queued, not rejected
- Spawns drain per-session, not cross-session
- Session A at limit does not block Session B spawn

**Phase 4:**
- `watchdog_wake` not enqueued when queue already has items for session
- `HEARTBEAT.md` `@heartbeat enabled false` disables watchdog
- `@heartbeat every 5m` maps to `intervalMs: 300_000`
- Rule classifier: each rule condition independently triggers wake

**Phase 5:**
- All `handleInternalMessage` callers produce queue items (no direct LLM calls)
- Zero messages dropped at `pendingInternalMessages` removal boundary

---

## 7. Open Questions

### Blocking (resolve before implementation)

**Q1 — Context re-hydration for `subagent_result`:**
Specified in §3.5. `SubagentResultPayload` must carry `parentAgentId`, `parentSessionKey`,
`runId`, `terminal`, `resultText`. `handleSubagentResult` reloads session context from store
if in-memory state is evicted. **Resolution: specified.**

**Q2 — Queue schema: new column vs repurpose `inbound_json`:**
Specified in §3.2. Add separate `event_payload TEXT` column. `inbound_json` remains typed
to `InboundMessage`, processed only when `event_type = "user_message"`. **Resolution: specified.**

**Q3 — `handleInternalMessage()` enqueue semantics:**
Specified in §3.4. Enqueue as `internal` event, priority 2, before `releaseSession()`.
Method signature unchanged. Feature flag for rollback. **Resolution: specified.**

### Non-blocking (can resolve during implementation)

**Q4 — `WatchdogStateCollector` read interfaces:**
Rough interfaces specified in §3.7.1. Exact method signatures confirmed during Phase 4
implementation against actual registry APIs.

**Q5 — Priority ordering edge cases:**
Defaults specified in §3.2. Tunable via config post-implementation.

**Q6 — Local model inference runtime:**
Rule-based classifier covers default path. Ollama HTTP API as first adapter.
Separate follow-on task.

**Q7 — `spawnQueue` persistence across restarts:**
Accepted as in-memory only (spawns are always live-context operations). Document in code.

---

## 8. Cost Impact (estimate)

| Scenario | Current | Proposed |
|----------|---------|----------|
| Idle (no user, no events) | LLM called every N minutes | **$0** |
| Active user session | Same | Same |
| Subagent completion | callback → direct LLM inject | queued → LLM on pump |
| Proactive (cron/reminder) | LLM always called at interval | Rule classifier ($0) → LLM only if event |
| Proactive (ambient awareness) | LLM called at interval | Fast model (~1/25 cost) → LLM only if wake |

---

## 9. Files Affected

**New files:**
- `src/runtime/core/enqueuer-ref.ts` — `EventEnqueuerRef` stable wrapper
- `src/runtime/watchdog/watchdog-service.ts`
- `src/runtime/watchdog/watchdog-read-facade.ts` — `WatchdogReadFacade` interface
- `src/runtime/watchdog/state-collector.ts` — state aggregator
- `src/runtime/watchdog/directive-reader.ts` — `HEARTBEAT.md` parser (shared with runner)
- `src/runtime/watchdog/classifier/rules.ts`
- `src/runtime/watchdog/classifier/api-model.ts`
- `src/runtime/watchdog/classifier/local-model.ts` (Phase 4+)

**Modified files:**
- `src/runtime/core/contracts.ts` — add `EventEnqueuer`, `EventType`, `SubagentResultPayload`
- `src/runtime/core/kernel/queue-item-processor.ts` — add type dispatch before `parseInbound`
- `src/runtime/core/kernel/runtime-queue.ts` — schema migration (new columns)
- `src/runtime/host/router.ts` — add `resolveSessionKeyFromRoute(agentId, route)` pure method
- `src/runtime/host/message-handler/services/run-lifecycle-registry.ts` — add `hasActiveRun(sessionKey)`
- `src/runtime/host/message-handler.ts` — `isSessionActive` delegates to `runLifecycle.hasActiveRun`; `handleInternalMessage` enqueues; `handleSubagentResult` added; remove `pendingInternalMessages` (Phase 5)
- `src/runtime/subagent-registry.ts` — add `enqueuer` via `HostSubagentRuntime`; per-session spawn queue
- `src/runtime/host/index.ts` — `EventEnqueuerRef` lifecycle; `buildWatchdogFacade()`; WatchdogService start/stop; `enqueuerRef.setTarget()` on kernel reload
- `src/runtime/host/sessions/spawn.ts` — `HostSubagentRuntime` gains `enqueuer` field
- `src/config/` — `watchdog:` config schema; `heartbeat:` aliases

**Deleted (Phase 5 only):**
- `pendingInternalMessages` Map (dead after Phase 1)
- `src/runtime/host/heartbeat.ts` — replaced by `WatchdogService` (deprecated after Phase 4)
