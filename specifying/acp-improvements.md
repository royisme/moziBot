# ACP Improvement Tasks — Implementation Spec

> Analysis based on comparison with OpenClaw ACP architecture.
> All issues confirmed via direct code inspection.
> Reviewed and revised by Opus (second pass).
> Implementation details added after full code read.

---

## Background

moziBot's ACP implementation is architecturally sound. The following pieces are confirmed working:
- `AcpRuntime` interface + backend registry (`src/acp/runtime/`)
- `SessionActorQueue` per-session serialization (`src/acp/control-plane/`)
- `RuntimeCache` with `collectIdleCandidates()` (`src/acp/control-plane/runtime-cache.ts`)
- `AcpSessionManager` with full observability snapshot shape (`src/acp/control-plane/manager.ts`)

Four specific gaps remain — all are incomplete wiring or duplication, not missing architecture.

---

## Task 1: Fix Idle Eviction — Add `runtime.close()` + Wire Timer

### Problem

`evictIdleRuntimes(cfg)` exists in `manager.ts` but has two bugs and no call site:

**Bug 1 — No timer, never called:**
```ts
// manager.ts — no setInterval anywhere in the class
constructor(deps: AcpSessionManagerDeps = DEFAULT_DEPS) {
  this.runtimeCache = new RuntimeCache();
  this.actorQueue = new SessionActorQueue();
  this.deps = deps;
  // ← no timer started
}
```

**Bug 2 — Clears cache but leaks the runtime process:**
```ts
evictIdleRuntimes(cfg: MoziConfig): number {
  // ...
  for (const candidate of idleCandidates) {
    if (this.activeTurns.has(candidate.actorKey)) continue;
    this.runtimeCache.clear(candidate.actorKey);  // ← cache cleared
    // ← runtime.close() never called, external process keeps running
    evicted++;
  }
  return evicted;
}
```

**Bug 3 — Observability hardcoded:**
```ts
getObservabilitySnapshot(): AcpManagerObservabilitySnapshot {
  const idleTtlMs = 0; // Would come from config
  return {
    runtimeCache: {
      activeSessions: cacheSnapshot.length,
      idleTtlMs,         // always 0
      evictedTotal: 0,   // always 0
      // lastEvictedAt missing
    },
    // ...
  };
}
```

### Implementation

**Step 1 — Add tracking fields** (after `private failedTurnsTotal = 0;`):

```ts
private evictedTotal = 0;
private lastEvictedAt?: number;
private evictionTimer?: ReturnType<typeof setInterval>;
```

**Step 2 — Fix `evictIdleRuntimes` to call `runtime.close()`** (async, rename):

```ts
async evictIdleRuntimes(cfg: MoziConfig): Promise<number> {
  const idleTtlMs = resolveRuntimeIdleTtlMs(cfg);
  if (idleTtlMs <= 0) return 0;

  const now = Date.now();
  const idleCandidates = this.runtimeCache.collectIdleCandidates({ maxIdleMs: idleTtlMs, now });

  let evicted = 0;
  for (const candidate of idleCandidates) {
    if (this.activeTurns.has(candidate.actorKey)) continue;

    // Signal the external process to close (was missing before)
    try {
      await candidate.state.runtime.close({
        handle: candidate.state.handle,
        reason: "idle-eviction",
      });
    } catch (err) {
      console.debug(`acp-manager: idle eviction close failed for ${candidate.actorKey}: ${String(err)}`);
    }

    this.runtimeCache.clear(candidate.actorKey);
    evicted++;
  }

  if (evicted > 0) {
    this.evictedTotal += evicted;
    this.lastEvictedAt = Date.now();
  }

  return evicted;
}
```

**Step 3 — Add `startEvictionTimer` and `stopEvictionTimer`:**

```ts
startEvictionTimer(cfg: MoziConfig): void {
  const idleTtlMs = resolveRuntimeIdleTtlMs(cfg);
  if (idleTtlMs <= 0) return;

  // Run at half the TTL interval so sessions don't wait a full TTL past expiry
  this.evictionTimer = setInterval(() => {
    this.evictIdleRuntimes(cfg).catch((err) => {
      console.debug(`acp-manager: eviction timer error: ${String(err)}`);
    });
  }, Math.max(idleTtlMs / 2, 30_000)); // minimum 30s interval
}

stopEvictionTimer(): void {
  if (this.evictionTimer !== undefined) {
    clearInterval(this.evictionTimer);
    this.evictionTimer = undefined;
  }
}
```

**Step 4 — Fix `getObservabilitySnapshot`:**

```ts
getObservabilitySnapshot(cfg?: MoziConfig): AcpManagerObservabilitySnapshot {
  const idleTtlMs = cfg ? resolveRuntimeIdleTtlMs(cfg) : 0;
  const cacheSnapshot = this.runtimeCache.snapshot();

  return {
    runtimeCache: {
      activeSessions: cacheSnapshot.length,
      idleTtlMs,
      evictedTotal: this.evictedTotal,
      lastEvictedAt: this.lastEvictedAt,
    },
    turns: {
      active: this.activeTurns.size,
      queueDepth: this.actorQueue.getTotalPendingCount(),
      completed: this.completedTurnsTotal,
      failed: this.failedTurnsTotal,
      averageLatencyMs: this.computeAverageLatency(),
      maxLatencyMs: this.computeMaxLatency(),
    },
    errorsByCode: Object.fromEntries(this.errorsByCode),
  };
}
```

**Step 5 — Wire `startEvictionTimer` at runtime startup** (find where `AcpSessionManager` is instantiated, call `manager.startEvictionTimer(cfg)` after construction; call `manager.stopEvictionTimer()` on shutdown).

### Files changed
- `src/acp/control-plane/manager.ts` — 4 steps above
- Runtime startup file (wherever `new AcpSessionManager()` is called) — add timer start/stop

### Acceptance criteria
- Idle sessions beyond `acp.runtime.ttlMinutes` are closed (process + cache)
- `evictedTotal` and `lastEvictedAt` report real values
- Timer is cleared cleanly on shutdown

---

## Task 2: Merge Duplicate Memory Flush Logic

### Problem

`memory-flush.ts` and `preflush.ts` are byte-for-byte equivalent logic:

```ts
// memory-flush.ts
const flushManager = new FlushManager();
const timeout = persistence.timeoutMs || 1500;
const result = await Promise.race([
  flushManager.flush({ messages, config: persistence }),
  new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Flush timeout")), timeout)),
]);
return result.ready;
// catch: logger.warn({ err, sessionKey }, "Memory flush failed or timed out")

// preflush.ts — identical, only param names differ
// persistence → persistenceConfig
// logger → deps.logger
// err wrapping: `err instanceof Error ? err : new Error(String(err))`  ← only real diff
```

### Implementation

**Step 1 — Create `src/memory/flush-with-timeout.ts`:**

```ts
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { ResolvedMemoryPersistenceConfig } from "./backend-config";
import { FlushManager } from "./flush-manager";

export async function runFlushWithTimeout(params: {
  sessionKey: string;
  messages: AgentMessage[];
  config: ResolvedMemoryPersistenceConfig;
  logger: { warn(obj: Record<string, unknown>, msg: string): void };
}): Promise<boolean> {
  const { sessionKey, messages, config, logger } = params;
  const flushManager = new FlushManager();
  try {
    const timeout = config.timeoutMs || 1500;
    const result = await Promise.race([
      flushManager.flush({ messages, config }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Flush timeout")), timeout),
      ),
    ]);
    return result.ready;
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err : new Error(String(err)), sessionKey },
      "Memory flush failed or timed out",
    );
    return false;
  }
}
```

**Step 2 — Rewrite `memory-flush.ts`** (keep export name for callers):

```ts
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { MoziConfig } from "../../../../config";
import type { ResolvedMemoryPersistenceConfig } from "../../../../memory/backend-config";
import { runFlushWithTimeout } from "../../../../memory/flush-with-timeout";

export async function flushMemoryWithLifecycle(params: {
  config: MoziConfig;
  sessionKey: string;
  agentId: string; // kept for API compat, unused
  messages: AgentMessage[];
  persistence: ResolvedMemoryPersistenceConfig;
  logger: { warn(obj: Record<string, unknown>, msg: string): void };
}): Promise<boolean> {
  return runFlushWithTimeout({
    sessionKey: params.sessionKey,
    messages: params.messages,
    config: params.persistence,
    logger: params.logger,
  });
}
```

**Step 3 — Rewrite `preflush.ts`** (keep export name for callers):

```ts
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { ResolvedMemoryPersistenceConfig } from "../../../../memory/backend-config";
import { runFlushWithTimeout } from "../../../../memory/flush-with-timeout";

export interface PreflushDeps {
  readonly logger: { warn(obj: Record<string, unknown>, msg: string): void };
}

export async function performMemoryFlush(params: {
  sessionKey: string;
  agentId: string; // kept for API compat, unused
  messages: AgentMessage[];
  persistenceConfig: ResolvedMemoryPersistenceConfig;
  deps: PreflushDeps;
}): Promise<boolean> {
  return runFlushWithTimeout({
    sessionKey: params.sessionKey,
    messages: params.messages,
    config: params.persistenceConfig,
    logger: params.deps.logger,
  });
}
```

### Files changed
- `src/memory/flush-with-timeout.ts` — new file
- `src/runtime/host/message-handler/services/memory-flush.ts` — delegate to shared
- `src/runtime/host/message-handler/services/preflush.ts` — delegate to shared

### Acceptance criteria
- Single implementation of flush-with-timeout logic
- All existing callers compile and pass tests with no signature changes
- `agentId` kept in both wrappers for backward compat but clearly marked unused

---

## Task 3: Persist Dispatch Pipeline Conversation Bindings

### Problem

`conversationToSession` is a plain `Map<string, string>` — lost on restart:

```ts
export class AcpDispatchPipeline {
  private readonly conversationToSession = new Map<string, string>(); // in-memory only

  constructor(params: { config: MoziConfig; adapter: AcpBridgeRuntimeAdapter }) {
    this.config = params.config;
    this.adapter = params.adapter;
    // ← no hydration from storage
  }
```

**Complexity note**: `bindMessageToSession` is currently `void` sync. Persisting requires async. All callers must update.

### Implementation

**Step 1 — Add `conversationKeys` to `SessionAcpMeta`** in `src/acp/types.ts`:

```ts
export type SessionAcpMeta = {
  // ... existing fields ...
  conversationKeys?: string[]; // channel:peer:thread keys bound to this session
};
```

**Step 2 — Inject persistence dep into pipeline constructor:**

```ts
import { listAcpSessionEntries, upsertAcpSessionMeta } from "../runtime/session-meta";

export class AcpDispatchPipeline {
  constructor(params: { config: MoziConfig; adapter: AcpBridgeRuntimeAdapter }) {
    this.config = params.config;
    this.adapter = params.adapter;
    this.hydrateConversationBindings(); // restore bindings on startup
  }

  private hydrateConversationBindings(): void {
    for (const entry of listAcpSessionEntries()) {
      for (const key of entry.acp?.conversationKeys ?? []) {
        this.conversationToSession.set(key, entry.sessionKey);
      }
    }
  }
```

**Step 3 — Make `bindMessageToSession` async, persist on bind:**

```ts
bindMessageToSession(params: AcpMessageBinding): void {
  // ... existing map logic ...

  const conversationKey = resolveConversationKey({ ... });
  if (conversationKey !== "::") {
    this.conversationToSession.set(conversationKey, sessionKey);

    // Persist async (fire-and-forget, non-blocking)
    upsertAcpSessionMeta({
      sessionKey,
      mutate: (current) => {
        if (!current) return null;
        const existing = current.conversationKeys ?? [];
        if (existing.includes(conversationKey)) return current;
        return { ...current, conversationKeys: [...existing, conversationKey] };
      },
    });
  }

  this.pruneBindings();
}
```

**Step 4 — Clear conversation keys on `closeSession`** in `manager.ts`:

```ts
// In closeSession(), after clearing meta:
if (input.clearMeta) {
  this.deps.upsertSessionMeta({ sessionKey, mutate: () => null });
} else {
  this.deps.upsertSessionMeta({
    sessionKey,
    mutate: (current) => current ? { ...current, conversationKeys: [] } : null,
  });
}
```

### Files changed
- `src/acp/types.ts` — add `conversationKeys`
- `src/acp/dispatch/pipeline.ts` — hydrate on construct, persist on bind
- `src/acp/control-plane/manager.ts` — clear `conversationKeys` on close

### Acceptance criteria
- After restart, `conversationToSession` is repopulated from stored session metas
- Closing a session clears its conversation keys from storage

---

## Task 4: Add TTL to Message and Conversation Bindings

### Problem

`pruneBindings()` is FIFO-only and only called from `bindMessageToSession` — stale entries in quiescent systems are never cleaned:

```ts
// pipeline.ts
private pruneBindings(): void {
  while (this.messageToSession.size > MAX_BINDINGS) {   // count only, no time
    const firstKey = this.messageToSession.keys().next().value;
    if (!firstKey) break;
    this.messageToSession.delete(firstKey);
  }
  while (this.conversationToSession.size > MAX_BINDINGS) { // same problem
    const firstKey = this.conversationToSession.keys().next().value;
    if (!firstKey) break;
    this.conversationToSession.delete(firstKey);
  }
}
```

### Implementation

**Step 1 — Add `boundAt` to `AcpMessageBinding`:**

```ts
export type AcpMessageBinding = {
  messageId: string;
  sessionKey: string;
  channelId: string;
  peerId: string;
  threadId?: string | number;
  boundAt: number; // ← add
};
```

**Step 2 — Add conversation timestamp map and default TTL constant:**

```ts
const DEFAULT_BINDING_TTL_MS = 24 * 60 * 60 * 1000; // 24h

export class AcpDispatchPipeline {
  private readonly messageToSession = new Map<string, AcpMessageBinding>();
  private readonly conversationToSession = new Map<string, string>();
  private readonly conversationBoundAt = new Map<string, number>(); // ← add
```

**Step 3 — Set `boundAt` on bind, track conversation timestamp:**

```ts
bindMessageToSession(params: AcpMessageBinding): void {
  // ...
  this.messageToSession.set(messageId, { ...params, messageId, sessionKey, boundAt: Date.now() });

  if (conversationKey !== "::") {
    this.conversationToSession.set(conversationKey, sessionKey);
    this.conversationBoundAt.set(conversationKey, Date.now()); // ← add
  }

  this.pruneBindings();
}
```

**Step 4 — Rewrite `pruneBindings` with TTL + also call from `dispatch`:**

```ts
private pruneBindings(): void {
  const ttlMs = this.config.acp?.dispatch?.messageBindingTtlMs ?? DEFAULT_BINDING_TTL_MS;
  const cutoff = Date.now() - ttlMs;

  // TTL eviction for messageToSession
  for (const [key, binding] of this.messageToSession) {
    if (binding.boundAt < cutoff) this.messageToSession.delete(key);
  }
  // FIFO safety net
  while (this.messageToSession.size > MAX_BINDINGS) {
    const firstKey = this.messageToSession.keys().next().value;
    if (!firstKey) break;
    this.messageToSession.delete(firstKey);
  }

  // TTL eviction for conversationToSession
  for (const [key, boundAt] of this.conversationBoundAt) {
    if (boundAt < cutoff) {
      this.conversationToSession.delete(key);
      this.conversationBoundAt.delete(key);
    }
  }
  // FIFO safety net
  while (this.conversationToSession.size > MAX_BINDINGS) {
    const firstKey = this.conversationToSession.keys().next().value;
    if (!firstKey) break;
    this.conversationToSession.delete(firstKey);
    this.conversationBoundAt.delete(firstKey);
  }
}
```

**Step 5 — Call `pruneBindings()` from `dispatch()` as well** (not just from `bind`):

```ts
async dispatch(params: { message: InboundMessage; sessionKey?: string }): Promise<AcpDispatchResult> {
  this.pruneBindings(); // ← add at top so cleanup runs even in quiescent systems
  // ... rest of dispatch ...
}
```

**Step 6 — Optionally expose config** in `src/config/types.acp.ts`:

```ts
export type AcpDispatchConfig = {
  enabled?: boolean;
  messageBindingTtlMs?: number; // default 24h
};
```

### Files changed
- `src/acp/dispatch/pipeline.ts` — `AcpMessageBinding`, `conversationBoundAt`, `pruneBindings`, `dispatch`
- `src/config/types.acp.ts` — add `messageBindingTtlMs` (optional)

### Acceptance criteria
- Bindings older than TTL (default 24h) are evicted regardless of count
- Cleanup runs on `dispatch()` even when no new binds arrive
- FIFO cap still enforced as secondary safety net
- `conversationBoundAt` stays in sync with `conversationToSession`

---

## Summary Table

| # | Task | Priority | Effort | Risk |
|---|------|----------|--------|------|
| 1 | Wire eviction timer + fix `runtime.close()` leak | High | Low | Low — method exists, 4 targeted changes |
| 2 | Merge duplicate flush logic | High | Low | Low — pure refactor, no behavior change |
| 3 | Persist conversation bindings | Medium | Medium | Medium — fire-and-forget upsert, no async boundary break |
| 4 | TTL on message + conversation bindings | Medium | Low | Low — additive changes, backward compatible |
