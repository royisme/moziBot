# Channels Module (`src/runtime/adapters/channels/`)

## Purpose

Channel adapters bridge external messaging transports into Mozi's normalized `InboundMessage` / `OutboundMessage` contracts.

Contract files:

- `src/runtime/adapters/channels/types.ts`
- `src/runtime/adapters/channels/plugin.ts`
- `src/runtime/adapters/channels/registry.ts`

Implementations:

- `telegram/plugin.ts`
- `discord/plugin.ts`
- `local-desktop/plugin.ts`

## Channel Contract

All channel plugins must implement `ChannelPlugin`:

- lifecycle: `connect()`, `disconnect()`
- messaging: `send()` (+ optional `editMessage`, `beginTyping`, `emitPhase`)
- status and event emission through `EventEmitter`

`InboundMessage` carries normalized sender/peer/media fields used by runtime host and multimodal ingest.

## Runtime Integration

`RuntimeHost.initializeChannels()` registers and connects plugins, then forwards message events into kernel enqueue.

If changing channel payload semantics, also inspect:

- `src/runtime/host/message-handler.ts`
- `src/multimodal/ingest.ts`
- `src/multimodal/outbound.ts`

## Where to Edit

### Add a new channel adapter

1. Create `src/runtime/adapters/channels/<name>/plugin.ts`
2. Implement `ChannelPlugin`
3. Register/wire in `RuntimeHost.initializeChannels()`
4. Add config schema entry in `src/config/schema/channels.ts`
5. Add tests

### Change message normalization fields

- Edit `types.ts` and adapter mapper code
- Also update `message-handler.ts`, multimodal ingest, and tests

## Verification

- `pnpm run test`
- Focus tests:
  - `src/runtime/adapters/channels/telegram/*.test.ts`
  - `src/runtime/adapters/channels/discord/*.test.ts`
  - `src/runtime/adapters/channels/local-desktop/*.test.ts`
  - `src/runtime/adapters/channels/registry.test.ts`

## Constraints

- Keep `InboundMessage` compatible with host/router/session-key expectations.
- For streaming/edit semantics, preserve graceful fallback when a channel does not support edits.
