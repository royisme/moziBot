# Spec: Command Bypass Queue (v2)

> Revised from v1 after design review. See "Design Review Notes" at end for changelog.

## Problem

All inbound messages — both system commands (`/tasks`, `/status`, `/stop`) and regular LLM messages — go through the same per-session SQLite queue in `pump-runner.ts`.

The pump enforces one active item per session at a time via `activeSessions`. This means:

1. User sends a message → LLM run starts, session locked in `activeSessions`
2. User sends `/tasks` → enqueued behind the LLM run
3. `/tasks` only executes after LLM finishes — response is blocked

**Most critical failure:** `/stop` is supposed to interrupt the LLM run, but its *confirmation reply* is queued behind the very run it is trying to stop. (The interrupt signal fires pre-queue, but the user sees no feedback.)

**Partial existing fix:** `enqueueInbound` in `kernel.ts` already detects `/stop` pre-queue and fires `handleStopCommand` immediately (interrupt signal + continuation cancel). However, the stop confirmation reply still waits in the queue, and other read-only commands remain fully blocked.

---

## Architecture Change

### Current

```
Channel → enqueueInbound → runtimeQueue (SQLite) → pump → per-session serial → orchestrator stages → command or LLM
```

### Target

```
Channel → enqueueInbound
              ├── bypass commands → channelRegistry.get() → messageHandler.handle() → orchestrator (short-circuits at command stage)
              ├── /stop → pre-queue interrupt (existing) + immediate confirmation via channel.send()
              └── everything else → runtimeQueue → pump → per-session serial
```

### Key design decisions

1. **Reuse existing `messageHandler.handle()`** — no new `handleDirect` method. The existing `handle(message, channel)` signature already accepts a `ChannelPlugin`. For bypass commands, the orchestrator runs `inbound → command` stages and short-circuits at "handled" before lifecycle/prompt/execution.

2. **Use real channel from registry** — `channelRegistry.get(channelId)` returns the actual `ChannelPlugin` adapter (Telegram, WeChat, etc.) with real `send()`. No need for `createRuntimeChannel` which wraps egress with delivery receipts. Bypass commands don't need receipt tracking.

3. **`/stop` gets special handling** — not routed through `handle()`. The pre-queue interrupt already fires; we only add an immediate `channel.send()` for user-visible confirmation. This avoids the triple-fire problem (pre-queue + command flow + handler).

4. **Commands self-declare bypass safety** — instead of a disconnected `Set<string>`, each command declares `{ bypassQueue: true }` in its handler registration. This keeps the classification co-located with the implementation.

---

## Command Classification

### Bypass queue (non-session-mutating, safe to run concurrently with LLM)

| Command | Reason | Concurrency note |
|---------|--------|------------------|
| `tasks` | Reads detached run registry | Separate from session message state |
| `status` | Reads runtime status | Snapshot read — may show stale `activeSessions` count, acceptable |
| `models` | Reads model registry | Immutable during runtime |
| `skills` / `skill` | Reads agent skills | Immutable during runtime |
| `whoami` | Reads identity | Static |
| `help` | Static text | No state access |
| `reminders` | Read/append reminders store | Separate from agent messages |
| `prompt_digest` | Reads current prompt metadata | Snapshot read — may race with prompt mutation, acceptable |
| `heartbeat` | Read/toggle heartbeat config | Writes to heartbeat config only, not session state |

### Conditional bypass

| Command | Condition | Reason |
|---------|-----------|--------|
| `context` | Read-only when no args | Reads session context; snapshot may race with active LLM appending messages — document as "point-in-time" |
| `stop` | Special path (not via `handle()`) | Pre-queue interrupt + immediate confirmation; see `/stop` section |

### Stay in queue (session-mutating)

| Command | Reason |
|---------|--------|
| `new` / `reset` | Calls `agentManager.resetSession()` — destructively clears message history |
| `compact` | Calls `agentManager.compactSession()` — mutates message history |
| `switch` | Changes active model mid-session |
| `reload` | Mutates agent config — unsafe if LLM run is active |
| `acp` | Session-mutating protocol commands |
| `setAuth` / `unsetAuth` / `listAuth` / `checkAuth` | Auth scope writes |
| `think` / `reasoning` | Mutates session metadata |
| Regular messages | All non-command text |

---

## Implementation

### Step 1: Extend command registration with `bypassQueue` flag

**File:** `src/runtime/host/message-handler/services/command-handlers.ts`

Add `bypassQueue` to the handler registration type:

```ts
export interface CommandRegistration {
  handler: CommandHandler;
  bypassQueue?: boolean;  // default false — safe by default
}

// Existing CommandHandlerMap becomes:
export type CommandHandlerMap = Partial<Record<ParsedCommandName, CommandRegistration>>;
```

**File:** `src/runtime/host/message-handler/services/command-map.ts` / `command-map-builder.ts`

Tag bypass commands at registration site:

```ts
// In createMessageCommandHandlerMap or buildCommandHandlerMap:
tasks: { handler: onTasks, bypassQueue: true },
status: { handler: onStatus, bypassQueue: true },
models: { handler: onModels, bypassQueue: true },
// ... etc per classification table
new: { handler: onNew },  // bypassQueue defaults to false
```

Add a helper to query bypass status:

```ts
export function isBypassCommand(name: string, handlerMap: CommandHandlerMap): boolean {
  const reg = handlerMap[name];
  return reg?.bypassQueue === true;
}
```

### Step 2: `/stop` immediate confirmation

**File:** `src/runtime/core/kernel/enqueue-coordinator.ts`

Extend `handleStopCommand` to send an immediate confirmation reply:

```ts
export async function handleStopCommand(params: {
  messageHandler: unknown;
  sessionKey: string;
  inbound: InboundMessage;
  channelRegistry?: ChannelRegistry;  // new param
}): Promise<void> {
  // ... existing interrupt logic (unchanged) ...

  // NEW: immediate confirmation reply
  if (params.channelRegistry) {
    const channel = params.channelRegistry.get(params.inbound.channel);
    if (channel) {
      await channel.send(params.inbound.peerId, {
        text: interrupted > 0
          ? `Stopped. (cancelled ${interrupted} queued item${interrupted > 1 ? "s" : ""})`
          : "Stop signal sent.",
      }).catch(err => logger.warn({ err }, "Failed to send /stop confirmation"));
    }
  }
}
```

After sending the immediate confirmation, `/stop` is **not enqueued** — return early from `enqueueInbound`.

### Step 3: Bypass routing in `enqueueInbound`

**File:** `src/runtime/core/kernel.ts`

After the existing `/stop` pre-queue handling block, add bypass routing:

```ts
async enqueueInbound(envelope: RuntimeInboundEnvelope): Promise<RuntimeEnqueueResult> {
  const context = this.resolveSessionContext(envelope.inbound);
  const text = envelope.inbound.text?.trim() ?? "";
  const commandToken = this.extractCommandToken(text);

  // --- Existing /stop pre-queue handling ---
  if (this.isStopCommand(commandToken)) {
    await handleStopCommand({
      messageHandler: this.messageHandler,
      sessionKey: context.sessionKey,
      inbound: envelope.inbound,
      channelRegistry: this.channelRegistry,  // NEW: pass registry for confirmation
    });
    // NEW: /stop is fully handled — do not enqueue
    return {
      accepted: true,
      deduplicated: false,
      queueItemId: envelope.id || randomUUID(),
      sessionKey: context.sessionKey,
    };
  }

  // --- NEW: bypass routing for read-only commands ---
  if (commandToken) {
    const bypass = await this.tryBypassCommand(envelope, context, commandToken);
    if (bypass) {
      return bypass;
    }
  }

  // ... existing enqueue logic (unchanged) ...
}
```

New private method on `RuntimeKernel`:

```ts
private async tryBypassCommand(
  envelope: RuntimeInboundEnvelope,
  context: { sessionKey: string; agentId: string },
  commandToken: string,
): Promise<RuntimeEnqueueResult | null> {
  // Get the handler map to check bypass flag
  // Note: handlerMap is built per-turn in message-handler; we need a cached/shared reference.
  // Option A: expose isBypassCommand on MessageHandler
  // Option B: kernel holds its own bypass set (simpler, less coupling)
  if (!this.messageHandler.isBypassCommand(commandToken)) {
    return null;
  }

  const channel = this.channelRegistry.get(envelope.inbound.channel);
  if (!channel) {
    logger.warn(
      { channelId: envelope.inbound.channel, command: commandToken },
      "Bypass command: channel not found, falling back to queue",
    );
    return null;  // graceful fallback: let it go through queue
  }

  const queueItemId = envelope.id || randomUUID();
  logger.info(
    {
      queueItemId,
      sessionKey: context.sessionKey,
      command: commandToken,
      channel: envelope.inbound.channel,
      peerId: envelope.inbound.peerId,
    },
    "Command bypassing queue (read-only)",
  );

  // Fire-and-forget: errors must not propagate to channel adapter
  void this.messageHandler.handle(envelope.inbound, channel).catch(err =>
    logger.error(
      { err, command: commandToken, sessionKey: context.sessionKey },
      "Bypass command execution failed",
    ),
  );

  return {
    accepted: true,
    deduplicated: false,
    queueItemId,
    sessionKey: context.sessionKey,
  };
}
```

### Step 4: Expose `isBypassCommand` on `MessageHandler`

**File:** `src/runtime/host/message-handler.ts`

```ts
isBypassCommand(commandName: string): boolean {
  // Delegate to the command map's bypass metadata.
  // The handler map is built per channel in createOrchestratorDeps,
  // but bypass classification is channel-independent (same commands are
  // always read-only regardless of channel). Use a static/cached check.
  return BYPASS_COMMAND_NAMES.has(commandName);
}
```

**Metadata ownership model (single source of truth):**

The bypass classification lives in one place: a static `BYPASS_COMMAND_METADATA` record defined in `src/runtime/host/message-handler/services/command-metadata.ts` (new file):

```ts
// command-metadata.ts — single source of truth for command classification
export const COMMAND_METADATA: Record<string, { bypassQueue: boolean }> = {
  tasks:         { bypassQueue: true },
  status:        { bypassQueue: true },
  models:        { bypassQueue: true },
  skills:        { bypassQueue: true },
  skill:         { bypassQueue: true },
  whoami:        { bypassQueue: true },
  help:          { bypassQueue: true },
  reminders:     { bypassQueue: true },
  prompt_digest: { bypassQueue: true },
  heartbeat:     { bypassQueue: true },
  context:       { bypassQueue: true },
  // All other commands default to bypassQueue: false (stay in queue)
};

export function isBypassCommand(name: string): boolean {
  return COMMAND_METADATA[name]?.bypassQueue === true;
}
```

This file has **no channel-bound deps**. Both `MessageHandler.isBypassCommand()` and `buildCommandHandlerMap()` import from it. No derived set, no duplication.

---

## `/stop` Handling: Before vs After

### Before (v1 spec)

```
/stop → pre-queue handleStopCommand (interrupt) → enqueue → queue wait → command flow /stop handler (interrupt again) → confirmation reply
```

Problem: triple interrupt call, confirmation delayed.

### After (v2 spec)

```
/stop → handleStopCommand (interrupt + immediate confirmation via channelRegistry) → return (not enqueued)
```

`/stop` never enters the queue. Interrupt fires once. Confirmation is immediate.

### `/stop` when no active run

If `interrupted === 0` and no session is in `activeSessions`, the confirmation should say **"No active run to stop."** rather than "Stop signal sent." Update `handleStopCommand`:

```ts
const hasActiveRun = params.activeSessions?.has(params.sessionKey) ?? false;
const text = interrupted > 0
  ? `Stopped. (cancelled ${interrupted} queued item${interrupted > 1 ? "s" : ""})`
  : hasActiveRun
    ? "Stop signal sent."
    : "No active run to stop.";
```

### Reply-order race with `/stop`

When `/stop` fires, the LLM run may have already buffered a final assistant reply in the channel adapter's send queue. The stop confirmation may arrive **before** the tail reply, causing the user to see:

```
User: /stop
Bot: Stopped.
Bot: [final LLM reply that was already in flight]
```

This is a known edge case. Mitigation: the stop confirmation text should be distinctive enough ("Stopped.") that users understand the ordering. A full fix (holding the confirmation until the run's send queue drains) is out of scope for v2.

---

## Concurrency Safety

### Safe reads (no lock needed)

| Data | Why safe |
|------|----------|
| Detached run registry (`/tasks`) | Independent store, not part of session message state |
| Model registry (`/models`) | Immutable after startup |
| Agent skills (`/skills`) | Immutable after startup |
| Identity (`/whoami`) | Static |
| Reminders store (`/reminders`) | Append-only, separate from agent message history |

### Snapshot reads (eventual consistency acceptable)

| Data | Race condition | Mitigation |
|------|---------------|------------|
| Session context (`/context`) | LLM run may be appending messages | Reply includes disclaimer: "showing context as of now; active run may add more" |
| Prompt digest (`/prompt_digest`) | Prompt may be rebuilding | Acceptable staleness |
| Runtime status (`/status`) | `activeSessions` set changing | Snapshot is informational only |
| Heartbeat config (`/heartbeat`) | Toggle may race with heartbeat timer | Last-write-wins, acceptable |

### Unsafe (stay in queue)

Any command that calls `agentManager.resetSession()`, `compactSession()`, or mutates `sessionMetadata`. These share mutable state with the LLM run and must be serialized.

### Session status and reactions

Bypass commands **do not update `SessionStatus`** (no `QUEUED → RUNNING → COMPLETED` transitions) and **do not emit status reactions** (typing indicators, etc.). This is intentional:

- Bypass commands are read-only and return fast — no need for "thinking" indicators.
- Setting `SessionStatus.RUNNING` would conflict with an already-running LLM turn on the same session.
- If a bypass command needs typing indicators in the future (e.g., a slow `/tasks` query), it should call `channel.beginTyping()` directly within its handler, not through the queue's status lifecycle.

---

## Graceful Fallback

If bypass routing fails for any reason (channel not found, handler throws, etc.), the command is **not silently lost**. Design:

1. `channelRegistry.get()` returns null → fall through to normal queue path (logged as warning)
2. `handle()` throws → caught by `.catch()`, logged as error. User sees no reply but can retry. **Note:** once bypass execution starts, it cannot "fall back" to the queue — the command was never enqueued. The only fallback to queue is pre-execution failures (channel not found, bypass check fails).
3. Command not recognized as bypass → falls through to queue (safe default)
4. `resolveSessionContext` fails → same error path as normal inbound handling (happens before bypass check, since `enqueueInbound` resolves context first)

No queue item is created for bypass commands. This means:
- No retry policy for bypass failures (acceptable: user can resend)
- No delivery receipt tracking (acceptable: read-only replies don't need audit)
- Queue metrics won't count bypass commands (add separate counter in `tryBypassCommand`)

---

## Observability

Add a structured log line in `tryBypassCommand` (shown in Step 3 code above) with:
- `command`, `sessionKey`, `channelId`, `peerId`, `queueItemId` (synthetic, for correlation)

Optionally emit a metric: `command_bypass_total{command="tasks"}` to track bypass vs queued command ratio.

---

## Validation

### Automated
- `pnpm run check` passes
- `pnpm run test` passes
- Unit test: `isBypassCommand` returns true for all classified commands, false for mutating ones
- Unit test: `tryBypassCommand` returns null for non-bypass commands (graceful fallback)
- Unit test: `/stop` handleStopCommand sends confirmation via channel and returns early

### Manual
- Send a long LLM prompt, then send `/tasks` while it runs → response appears immediately
- Send a long LLM prompt, then `/stop` → confirmation reply appears immediately, LLM run aborts
- Send a long LLM prompt, then `/status` → status snapshot appears immediately
- Send `/unknown_command` → goes through queue normally (not bypassed)
- Kill channel adapter mid-bypass → error logged, no crash

---

## Design Review Notes (v1 → v2 changelog)

### Flaws fixed from v1

1. **ChannelPlugin construction solved**: Use `channelRegistry.get(channelId)` to get the real channel adapter directly. No `createRuntimeChannel` or `RuntimeQueueItem` needed. Bypass commands don't need delivery receipt tracking.

2. **Removed redundant `handleDirect`**: Reuse existing `messageHandler.handle(message, channel)`. No new method with identical signature.

3. **Full orchestrator is acceptable**: The orchestrator runs `inbound → command` and short-circuits at "handled" before lifecycle/prompt/execution. The only overhead is inbound parsing (session resolution), which is cheap and needed anyway. No wasted work.

4. **`/stop` triple-fire eliminated**: `/stop` now handled entirely in `handleStopCommand` with immediate confirmation. Never enters queue or command flow. Single interrupt call.

5. **Self-declaring bypass safety**: Commands declare `{ bypassQueue: true }` at registration site, co-located with the handler. No disconnected `Set<string>` file.

6. **Observability added**: Structured log line in `tryBypassCommand`. Optional metric counter. Bypass commands are no longer invisible.

7. **Concurrency safety documented**: Explicit table of safe reads, snapshot reads, and unsafe operations. `/context` gets a staleness disclaimer in its reply.

8. **Graceful fallback on failure**: Channel not found → fall through to queue. Handler throws → logged, user can retry. No silent message loss.

### Remaining risks

- If a future command is marked `bypassQueue: true` but actually writes session state, it will corrupt data. Mitigation: code review + unit test that asserts bypass commands don't call known mutating methods.
- Extension commands (registered via `dispatchExtensionCommand`) are not covered by bypass classification. Extensions always go through the queue. If a future extension needs bypass, the extension registration API must be extended with a `bypassQueue` flag.
- `CommandHandlerMap` type changes from `Record<string, CommandHandler>` to `Record<string, CommandRegistration>`. All call sites of `dispatchParsedCommand` and tests that build mock handler maps must be updated. This is a moderate refactor surface.
