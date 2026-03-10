# Implementation Guide: Agent `send_media` Tool

## Affected Files

### New Files
| File | Purpose |
|------|---------|
| `src/runtime/tools/send-media.ts` | Tool factory and handler |
| `src/runtime/tools/send-media.test.ts` | Unit tests (6 test groups) |

### Modified Files
| File | Change |
|------|--------|
| `src/runtime/agent-manager/tool-builder.ts` | Add `createSendMediaTool?` to `BuildToolsDeps` |
| `src/runtime/agent-manager.ts` | Add `sessionContexts` map + `registerSessionContext` / `getSessionContext` methods |
| `src/runtime/agent-manager/prompt-builder.ts` | Add `registeredTools?` param to `buildChannelContext` |
| `src/runtime/host/message-handler/flow/execution-flow.ts` | Call `registerSessionContext` at turn start, clean up at turn end |
| `src/runtime/host/message-handler.ts` | Inject `createSendMediaTool` into `setToolProvider` |

---

## Key Type Signatures

### `src/runtime/tools/send-media.ts`

```ts
export interface SendMediaToolDeps {
  getChannel: () => ChannelDispatcherBridge | undefined;
  getPeerId: () => string | undefined;
  workspaceDir: string;
  extraLocalRoots?: string[];
}

export function createSendMediaTool(deps: SendMediaToolDeps): AgentTool
```

The complete implementation is in spec Section 5. Copy it verbatim.

### `src/runtime/agent-manager.ts` — new members

```ts
// Private field (add alongside other Map fields at class top)
private sessionContexts = new Map<string, { channel: ChannelDispatcherBridge; peerId: string }>();

// Public methods (add near disposeRuntimeSession)
registerSessionContext(
  sessionKey: string,
  ctx: { channel: ChannelDispatcherBridge; peerId: string },
): void {
  this.sessionContexts.set(sessionKey, ctx);
}

getSessionContext(
  sessionKey: string,
): { channel: ChannelDispatcherBridge; peerId: string } | undefined {
  return this.sessionContexts.get(sessionKey);
}
```

`disposeRuntimeSession` must also call `this.sessionContexts.delete(sessionKey)`.

Import needed: `import type { ChannelDispatcherBridge } from "./host/message-handler/contract";`

### `src/runtime/agent-manager/tool-builder.ts` — `BuildToolsDeps` addition

```ts
export interface BuildToolsDeps {
  // ... existing fields ...
  createSendMediaTool?: (params: { workspaceDir: string; homeDir: string }) => AgentTool;
}
```

In `buildTools()`, insert before the `toolProvider` block:

```ts
if (deps.createSendMediaTool && allowSet.has("send_media")) {
  tools.push(
    deps.createSendMediaTool({ workspaceDir: params.workspaceDir, homeDir: params.homeDir }),
  );
}
```

### `src/runtime/agent-manager/prompt-builder.ts` — `buildChannelContext` signature change

```ts
export function buildChannelContext(
  message: InboundMessage,
  currentChannel?: CurrentChannelContext,
  registeredTools?: string[],   // NEW
): string
```

Inside the function, replace the `allowedActions` line:

```ts
// Before (line 45):
`allowedActions: ${currentChannel.allowedActions.map(...).join(", ")}`

// After:
const effectiveActions = currentChannel.allowedActions.filter((action) => {
  if (action === "send_media") return registeredTools?.includes("send_media") ?? false;
  return true;
});
lines.push(`allowedActions: ${effectiveActions.map((a) => sanitizePromptLiteral(a)).join(", ")}`);
```

Add usage hint after the `allowedActions` line:

```ts
if (effectiveActions.includes("send_media")) {
  lines.push(
    "When send_media is listed, use the send_media tool with a local filePath — do not search for tokens or scripts.",
  );
}
```

### `src/runtime/agent-manager.ts` — `ensureChannelContext` call site

In `ensureChannelContext()` at line 597, pass registered tools:

```ts
// Before:
const channelContext = buildChannelContext(message, currentChannel);

// After:
const registeredTools = this.promptToolsBySession.get(sessionKey);
const channelContext = buildChannelContext(message, currentChannel, registeredTools);
```

---

## execution-flow.ts: Session Context Registration

In `runExecutionFlow` (`src/runtime/host/message-handler/flow/execution-flow.ts`):

**Insert after `const channel = getChannel(payload)` (currently line 162):**

```ts
// Register session context for send_media tool lazy lookup
deps.registerSessionContext?.(sessionKey, { channel, peerId });
```

**The `OrchestratorDeps` contract** (`contract.ts`) needs a new optional method:

```ts
registerSessionContext?(sessionKey: string, ctx: { channel: ChannelDispatcherBridge; peerId: string }): void;
```

The concrete implementation in `orchestrator-deps-builder.ts` (or equivalent wiring file) maps this to `agentManager.registerSessionContext(...)`.

Cleanup: `disposeRuntimeSession` on `AgentManager` already deletes from `sessionContexts` — no explicit flow-level cleanup needed.

---

## message-handler.ts: Tool Provider Wiring

In `src/runtime/host/message-handler.ts`, extend the `setToolProvider` callback (around line 244):

```ts
this.agentManager.setToolProvider((params) => {
  const tools: AgentTool[] = [];

  // existing session/browser tools (when deps available)
  if (deps?.sessionManager && deps?.detachedRunRegistry) {
    tools.push(
      ...createSessionTools({ ... }),
      ...createBrowserTools({ ... }),
    );
  }

  // NEW: send_media
  tools.push(
    createSendMediaTool({
      workspaceDir: params.workspaceDir,
      getChannel: () => this.agentManager.getSessionContext(params.sessionKey)?.channel,
      getPeerId: () => this.agentManager.getSessionContext(params.sessionKey)?.peerId,
    }),
  );

  return tools;
});
```

Note: `setToolProvider` is currently only called when `deps?.sessionManager` exists. The send_media injection should be unconditional — restructure the conditional accordingly.

---

## Agent Config: Allowlist Entry

For any agent that should have `send_media`, add to the agent's config in `mozi.yaml`:

```yaml
agents:
  mozi:
    tools:
      - send_media
      # ... other tools
```

`send_media` will not appear unless explicitly listed (enforced by `allowSet.has("send_media")` in `buildTools`).

---

## Execution Order Summary

1. Turn starts → `runExecutionFlow` calls `deps.registerSessionContext(sessionKey, { channel, peerId })`
2. LLM calls `send_media` → `createSendMediaTool.execute()` runs → calls `deps.getChannel()` → resolves via `agentManager.getSessionContext(sessionKey)?.channel`
3. Tool calls `channel.send(peerId, { media })` directly
4. Turn ends → `disposeRuntimeSession` clears `sessionContexts` entry
