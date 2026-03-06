# Unified Delivery / Route Context Specification

## Overview
moziBot already carries enough routing primitives to send a reply back to the originating Telegram or Discord conversation, but those primitives remain scattered across inbound messages, last-route memory, agent-job persistence, reminder/heartbeat synthesis, and outbound dispatch call sites. This specification defines a canonical route/delivery context layer so the runtime can share one OpenClaw-style routing model across direct replies, detached runs, continuations, followups, and reminders.

The design goal is not to invent another send abstraction. It is to normalize channel/peer/thread/account routing into stable typed objects with clear ownership boundaries, then migrate existing Telegram and Discord codepaths to consume that canonical model.

## Goals
- Introduce canonical routing types that represent conversation destination and delivery intent without channel-specific scattered params.
- Define clean boundaries between inbound context, derived session context, remembered last-route state, persisted agent-job state, and outbound dispatch.
- Ensure Telegram and Discord share the same routing model, including thread-aware replies.
- Ensure continuations, followups, reminders, heartbeat wakes, and detached jobs inherit route context deterministically.
- Replace multi-arg reply dispatch signatures with a unified object that can be extended safely.
- Provide a low-risk migration sequence aligned with current working-tree plumbing.

## Non-goals
- Reworking router agent-selection rules or session-key semantics beyond consuming the canonical route context.
- Changing prompt contract behavior that already defaults replies back to the same conversation.
- Replacing channel-specific send/edit implementations.
- Introducing durable database persistence for routes beyond the existing in-memory job/last-route mechanisms.
- Expanding scope into new channel features unrelated to routing context.

## Interface Design

### Erotetic framing E(X,Q)
- X = unified delivery/route context layer for runtime, jobs, and channel dispatch.
- Q1: What canonical types should exist?
  - A canonical `RouteContext` should model the destination identity of a conversation turn.
  - A canonical `DeliveryContext` should wrap a `RouteContext` plus delivery behavior fields for outbound dispatch.
- Q2: Where should they live?
  - Shared runtime-level types should live under `src/runtime/host/routing/` so host orchestration, jobs, reminders, and channel dispatch all depend on the same module instead of channel adapters or message-router helpers.
- Q3: What owns each stage?
  - Inbound adapters populate raw route fields on `InboundMessage`.
  - Host routing derives canonical `RouteContext` from inbound payload.
  - Last-route memory stores only normalized `RouteContext` snapshots.
  - Agent jobs persist a normalized route snapshot, not scattered channel fields.
  - Outbound delivery consumes `DeliveryContext`.
- Q4: How do Telegram and Discord unify?
  - Both map to the same canonical shape: `channelId`, `peerId`, `peerType`, optional `accountId`, optional `threadId`, optional `replyToId`.
  - Platform-specific semantics stay in adapter send logic; route shape stays platform-agnostic.
- Q5: How do inherited flows work?
  - Followups, continuations, detached runs, reminders, and heartbeat synthesize or copy a `RouteContext` from the originating turn or remembered session route.
- Q6: What is the acceptance boundary?
  - No reply path should need separate `peerId/channelId/threadId/accountId` positional plumbing once migrated.

### Canonical types
Add a new shared host routing module, recommended as:
- `src/runtime/host/routing/types.ts`
- `src/runtime/host/routing/route-context.ts`

Proposed canonical interfaces:

```ts
export interface RouteContext {
  readonly channelId: string;
  readonly peerId: string;
  readonly peerType: "dm" | "group" | "channel";
  readonly accountId?: string;
  readonly threadId?: string;
  readonly replyToId?: string;
}

export interface DeliveryContext {
  readonly route: RouteContext;
  readonly traceId?: string;
  readonly sessionKey?: string;
  readonly agentId?: string;
  readonly source?: "turn" | "job" | "followup" | "reminder" | "heartbeat" | "system";
}
```

Normalization rules:
- `channelId`, `peerId`, and `peerType` are required.
- `threadId` is normalized to string when present.
- `accountId` is normalized to string when present.
- `replyToId` is optional and only used when an outbound reply should anchor to a specific prior message.
- Canonical route objects are immutable-by-convention; helpers return normalized copies.

Recommended helper surface:

```ts
export function normalizeRouteContext(input: {
  channelId: string;
  peerId: string;
  peerType: "dm" | "group" | "channel";
  accountId?: string | number;
  threadId?: string | number;
  replyToId?: string | number;
}): RouteContext;

export function routeContextFromInbound(message: InboundMessage): RouteContext;

export function routeContextToOutboundMessage(
  route: RouteContext,
  message: OutboundMessage,
): OutboundMessage;

export function sameRouteContext(a: RouteContext | null | undefined, b: RouteContext | null | undefined): boolean;
```

### Session resolution contract
`resolveSessionContext(...)` should stop returning only `{ sessionKey, agentId, ... }` and instead return a richer object:

```ts
export interface ResolvedTurnContext {
  readonly agentId: string;
  readonly sessionKey: string;
  readonly dmScope?: "main" | "per-peer" | "per-channel-peer" | "per-account-channel-peer";
  readonly route: RouteContext;
}
```

This keeps session resolution and route resolution together, but separate concerns remain explicit:
- `sessionKey` is for transcript/session identity.
- `route` is for delivery destination identity.

### Last-route memory contract
Replace the ad hoc `LastRoute` shape with either:
- a direct alias of `RouteContext`, or
- a wrapper type if future metadata is needed.

Preferred version:

```ts
export type LastRouteContext = RouteContext;
```

Last-route memory should only represent the latest known outbound-capable destination for an agent/session. It must not become a dumping ground for session metadata, prompt info, or job state.

### Agent job persistence contract
`AgentJob` and `CreateAgentJobInput` should migrate from top-level scattered route fields to canonical route storage:

```ts
export interface AgentJob {
  readonly id: string;
  readonly sessionKey: string;
  readonly agentId: string;
  readonly route: RouteContext;
  // existing non-route fields remain
}
```

Compatibility migration rule:
- During migration, constructors/helpers may accept legacy top-level `channelId/peerId/accountId/threadId` input but must immediately collapse them into `route`.
- Final target state removes direct route primitives from `AgentJob` once all call sites are migrated.

### Unified outbound dispatch contract
Current dispatch APIs pass scattered params. Replace with a single object:

```ts
export interface ReplyDispatchRequest {
  readonly delivery: DeliveryContext;
  readonly replyText?: string;
  readonly inboundPlan: DeliveryPlan | null;
}
```

Dispatcher signature target:

```ts
export type DispatchReply = (request: ReplyDispatchRequest) => Promise<string | null>;
```

Job delivery target:

```ts
export interface AgentJobDeliveryDispatcher {
  send(params: {
    delivery: DeliveryContext;
    replyText?: string;
  }): Promise<string>;
}
```

Channel send boundary:
- `ChannelPlugin.send(peerId, message)` remains unchanged in this phase to keep migration contained.
- Host-side dispatch owns flattening `DeliveryContext.route` into adapter-compatible `peerId` plus `OutboundMessage` fields.
- A later phase may consider `channel.send({ route, message })`, but that is out of scope here.

## Data Model

### Layered routing model
1. Inbound adapter layer
   - Emits `InboundMessage` with raw routing primitives: `channel`, `peerId`, `peerType`, optional `accountId`, optional `threadId`, optional `replyToId`.
2. Canonical route derivation layer
   - Converts inbound message into `RouteContext`.
3. Session resolution layer
   - Combines router output with `RouteContext` to produce `ResolvedTurnContext`.
4. Last-route memory layer
   - Stores normalized `RouteContext` keyed by agent or session, per existing ownership pattern.
5. Job persistence layer
   - Stores `RouteContext` in `AgentJob` so detached delivery does not reconstruct destination from unrelated fields.
6. Outbound delivery layer
   - Consumes `DeliveryContext` and creates adapter-specific `OutboundMessage`.

### State transitions
#### Direct inbound turn
- Adapter emits `InboundMessage`.
- Host resolves `ResolvedTurnContext`.
- Host remembers `route` as latest route.
- Prompt execution and reply dispatch use `delivery.route` from resolved context.

#### Detached followup / agent job
- Creator copies originating `RouteContext` into job record.
- Runner executes prompt detached from inbound adapter.
- Delivery uses `job.route` through `DeliveryContext`.

#### Reminder / continuation / heartbeat
- If spawned from an existing turn, route is copied from origin.
- If synthesized later, route is loaded from remembered `LastRouteContext`.
- Synthetic inbound messages must either include the recovered route fields or pass canonical route objects directly into the call site building them.

### Ownership boundaries
- `InboundMessage` is transport-normalized input, not the canonical long-lived route container.
- `RouteContext` is the canonical reusable route container.
- `ResolvedTurnContext` binds route + session result for a single inbound turn.
- `LastRouteContext` is ephemeral memory of the latest usable destination.
- `AgentJob.route` is persisted delivery state for detached execution.
- `DeliveryContext` is outbound-only execution context.

## Boundary Conditions
- Missing `threadId` is valid and means base peer/channel delivery.
- `threadId` must be treated as opaque string at the canonical layer even if Telegram currently needs numeric conversion at adapter send time.
- Discord thread replies and Telegram forum topic replies must map to the same `route.threadId` field.
- `accountId` may be absent for most channels; its presence must not be assumed outside session-key logic and future account-aware dispatch.
- `replyToId` should not be auto-populated for all sends; only use it when semantic reply anchoring is desired.
- Last-route memory can be stale. If a remembered route no longer exists or delivery fails, the failure should surface in existing delivery/job error handling; the canonical route layer does not add silent fallback routing.
- Synthetic system messages should not invent new routing dimensions; they inherit from an existing `RouteContext` or abstain from sending.
- Migration must preserve current working behavior for Telegram thread delivery and Discord thread delivery.
- Legacy fields may coexist briefly during migration, but canonical helpers become the only place allowed to normalize route primitives.

## Acceptance Criteria
1. A shared `RouteContext` type exists under a host routing module and is reused by session resolution, last-route memory, and job delivery types.
2. A shared `DeliveryContext` type exists and outbound reply dispatch accepts a unified object instead of separate channel/peer/thread params.
3. `resolveSessionContext` returns canonical route data together with `sessionKey` and `agentId`.
4. Last-route memory stores normalized canonical route objects rather than ad hoc duplicated structures.
5. `AgentJob` persistence stores canonical route state sufficient for detached reply delivery without scattered top-level route fields.
6. Telegram and Discord inbound adapters both map thread-aware context into the same canonical routing model.
7. Reminder, continuation, heartbeat, and detached followup paths explicitly inherit route context from origin or last-route memory.
8. Host dispatch remains backward-compatible with existing channel plugin send implementations during this phase.
9. Regression tests cover Telegram topic/thread routing, Discord thread routing, agent-job delivery inheritance, and synthetic flows using remembered routes.

## Dependencies
- Existing `InboundMessage` / `OutboundMessage` contracts in `src/runtime/adapters/channels/types.ts`.
- Host routing/session utilities in `src/runtime/host/message-handler/services/message-router.ts` and `src/runtime/host/session-key.ts`.
- Orchestrator dependency wiring in `src/runtime/host/message-handler/services/orchestrator-deps-slices.ts`.
- Agent job registry/delivery types in `src/runtime/jobs/types.ts`, `src/runtime/jobs/registry.ts`, and `src/runtime/jobs/delivery.ts`.
- Synthetic route producers in `src/runtime/host/reminders/runner.ts` and `src/runtime/host/heartbeat.ts`.
- Host dispatch wiring in `src/runtime/host/index.ts` and reply execution flow in `src/runtime/host/message-handler/flow/execution-flow.ts`.

## Migration Sequence
1. Add canonical routing module under `src/runtime/host/routing/` with normalized types and helpers.
2. Refactor `message-router.ts` to return `ResolvedTurnContext` including canonical `route`.
3. Refactor `MessageHandler` and orchestrator deps to use `resolved.route` and replace custom last-route map shapes with canonical route storage.
4. Introduce unified reply dispatch request/delivery context object in host reply dispatcher and execution flow call sites.
5. Migrate agent-job types, registry, and delivery to persist and use `job.route`, keeping a temporary compatibility layer only where needed.
6. Update reminder and heartbeat producers to recover or pass canonical routes explicitly.
7. Update host bootstrap wiring in `src/runtime/host/index.ts` to construct delivery requests from `DeliveryContext`.
8. Expand regression tests for Telegram, Discord, jobs, reminders, and heartbeat inheritance.

## Concrete File Targets
- Add:
  - `src/runtime/host/routing/types.ts`
  - `src/runtime/host/routing/route-context.ts`
- Modify:
  - `src/runtime/host/message-handler/services/message-router.ts`
  - `src/runtime/host/message-handler.ts`
  - `src/runtime/host/message-handler/services/orchestrator-deps-slices.ts`
  - `src/runtime/host/message-handler/flow/execution-flow.ts`
  - `src/runtime/jobs/types.ts`
  - `src/runtime/jobs/registry.ts`
  - `src/runtime/jobs/delivery.ts`
  - `src/runtime/host/index.ts`
  - `src/runtime/host/reminders/runner.ts`
  - `src/runtime/host/heartbeat.ts`
  - tests covering the above areas

## Test Plan
- Unit tests for route normalization helpers:
  - string normalization of `accountId`, `threadId`, `replyToId`
  - equality/serialization behavior
- Message-router tests:
  - resolved session context includes canonical route
  - route preserves thread/account fields
- Execution/reply dispatch tests:
  - reply dispatch takes unified request object
  - thread-aware delivery continues to reach adapters correctly
- Agent-job tests:
  - registry stores `job.route`
  - delivery uses `job.route` and emits expected delivery events
- Synthetic flow tests:
  - reminder job inherits stored route context
  - heartbeat wake reconstructs route from last-route memory
- Channel regression tests:
  - Telegram topic/thread message inbound + outbound continuity
  - Discord thread inbound + outbound continuity
- Command to run targeted regression scope during implementation:
  - `pnpm run test -- src/runtime/jobs/delivery.test.ts src/runtime/host/router.test.ts src/runtime/host/message-handler.test.ts src/runtime/adapters/channels/discord/plugin.test.ts`
