# Task 02: /stop immediate confirmation and early return

## Objective

Make `/stop` send an immediate user-visible confirmation reply and stop enqueueing the command.

## Files

- `src/runtime/core/kernel/enqueue-coordinator.ts` (MODIFY)
- `src/runtime/core/kernel.ts` (MODIFY)

## Steps

1. In `enqueue-coordinator.ts`, extend `handleStopCommand` params:
   - Add optional `channelRegistry?: ChannelRegistry`
   - Add optional `activeSessions?: Set<string>`
   - After existing interrupt logic, send immediate confirmation via `channelRegistry.get(inbound.channel)?.send()`
   - Use contextual message: "Stopped. (cancelled N items)" / "Stop signal sent." / "No active run to stop."

2. In `kernel.ts` `enqueueInbound`:
   - Pass `channelRegistry: this.channelRegistry` and `activeSessions: this.pumpState.activeSessions` to `handleStopCommand`
   - After `handleStopCommand` completes, **return early** with `{ accepted: true, ... }` — do NOT continue to enqueue

## Validation

- `pnpm run test` passes
- Unit test: `handleStopCommand` with `channelRegistry` calls `channel.send()` with confirmation text
- Unit test: `handleStopCommand` without active run returns "No active run to stop."
- Manual: send `/stop` during active LLM run → immediate confirmation, run aborts

## Dependencies

None — independent of Task 01.

## Risk

Low. The existing pre-queue `/stop` logic is already in place; we're adding confirmation and early return.
