# Runtime Module (`src/runtime/`)

## Purpose

`src/runtime/` is Mozi's orchestration core. It wires inbound channel messages into queue processing, agent execution, persistence, and outbound delivery.

Primary orchestrators:

- `src/runtime/host/index.ts` (`RuntimeHost`)
- `src/runtime/core/kernel.ts` (`RuntimeKernel`)
- `src/runtime/agent-manager.ts` (`AgentManager`)

## Key Subdirectories

- `host/` - runtime lifecycle, message handler, routing, session supervision
- `core/` - queue pump, enqueue/dispatch, egress, retry/interrupt policy
- `adapters/channels/` - channel plugin interfaces and concrete adapters
- `sandbox/` - sandbox bootstrap/probe and executor wiring
- `context-management/` + `context-pruning/` - token budgets, compaction, overflow handling

For deep implementation details, read:

- [runtime-host.md](./runtime-host.md)
- [runtime-core.md](./runtime-core.md)
- [sandbox.md](./sandbox.md)

## Request Flow (Code-Backed)

1. `RuntimeHost` starts config/db/channels/kernel (`src/runtime/host/index.ts`).
2. Channel plugin emits inbound message to host registry.
3. `RuntimeKernel.enqueueInbound()` records/queues work (`src/runtime/core/kernel.ts`).
4. Kernel dispatches to `MessageHandler` for command/routing/agent execution.
5. `AgentManager` resolves model/tools/context/session state for target agent.
6. Response goes through render + channel send/edit path.

## Where to Edit for Common Changes

### Change queue behavior

- Edit: `src/runtime/core/kernel.ts`
- Also inspect:
  - `src/runtime/core/contracts.ts`
  - `src/storage/db.ts` (`runtimeQueue` store)

### Change message command behavior (`/models`, `/switch`, `/status`)

- Edit: `src/runtime/host/message-handler.ts`
- Also inspect:
  - `src/runtime/model-registry.ts`
  - `src/runtime/host/reply-utils.ts`

Auth-related commands are also handled here:

- `/setAuth`
- `/unsetAuth`
- `/listAuth`
- `/checkAuth`

And missing-secret guidance path (`AUTH_MISSING ...`) is surfaced here.

### Change session persistence / restore

- Edit: `src/runtime/session-store.ts`
- Also inspect:
  - `src/runtime/agent-manager.ts`
  - `src/runtime/host/message-handler.ts` (rotation triggers)
  - `src/storage/db.ts` (sessions table API)

Session lifecycle notes:

- `sessionKey` is routing identity only
- runtime persists segmented state with one `latest` segment and archived immutable history
- `/new` rotates segment id (hard cut)
- temporal + semantic policies can auto-rotate when configured

### Change runtime auth / secret resolution behavior

- Edit:
  - `src/runtime/auth/*`
  - `src/runtime/sandbox/tool.ts` (`exec` authRefs path)
  - `src/runtime/host/message-handler.ts` (auth commands and guidance)
- Also inspect:
  - `src/storage/db.ts` (`auth_secrets` table/DAO)
  - `src/config/schema/runtime.ts`
  - `src/config/schema/agents.ts` (`exec.allowedSecrets`)

### Change runtime startup/daemon behavior

- Edit: `src/runtime/host/index.ts` and `src/runtime/host/main.ts`
- Also inspect:
  - `src/cli/runtime.ts`
  - `src/runtime/host/lifecycle.ts`

## Verification Checklist

When editing runtime internals:

1. `pnpm run test`
2. `pnpm run check`
3. Focus tests when needed:
   - `src/runtime/core/*.test.ts`
   - `src/runtime/host/*.test.ts`
   - `src/runtime/host/message-handler*.test.ts`

## Constraints / Gotchas

- Queue behavior and session state are coupled through db + in-memory state; avoid changing one without checking the other.
- Model routing and multimodal routing are coordinated in host/message path; keep messaging text and fallback semantics aligned.
- Do not bypass `AgentManager` when adding runtime-triggered agent actions.
