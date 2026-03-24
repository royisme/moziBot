# Task 03: Bypass routing in enqueueInbound

## Objective

Route non-session-mutating commands directly to `messageHandler.handle()` without entering the SQLite queue.

## Files

- `src/runtime/core/kernel.ts` (MODIFY)
- `src/runtime/host/message-handler.ts` (MODIFY)

## Steps

1. In `message-handler.ts`, add `isBypassCommand(commandName: string): boolean` method that delegates to `isBypassCommand` from `command-metadata.ts`.

2. In `kernel.ts`, add private method `tryBypassCommand(envelope, context, commandToken)`:
   - Check `this.messageHandler.isBypassCommand(commandToken)`
   - Get channel via `this.channelRegistry.get(envelope.inbound.channel)`
   - If channel not found → return null (fall through to queue, log warning)
   - Log structured bypass event
   - Fire-and-forget `this.messageHandler.handle(envelope.inbound, channel)` with `.catch()` error logging
   - Return `RuntimeEnqueueResult` with `accepted: true`

3. In `enqueueInbound`, after the `/stop` early-return block, add:
   ```ts
   if (commandToken) {
     const bypass = await this.tryBypassCommand(envelope, context, commandToken);
     if (bypass) return bypass;
   }
   ```

## Validation

- `pnpm run check` passes
- `pnpm run test` passes
- Unit test: bypass command returns `accepted: true` without enqueuing
- Unit test: non-bypass command returns null (falls through)
- Unit test: missing channel falls through to queue
- Manual: `/tasks` responds immediately during active LLM run

## Dependencies

- Requires Task 01 (command-metadata.ts must exist for `isBypassCommand`)
- Independent of Task 02

## Risk

- `messageHandler.handle()` runs the full orchestrator pipeline for bypass commands. This is safe because commands short-circuit at the "command" stage, but verify no lifecycle side effects fire before the command stage.
- Fire-and-forget means errors are logged but user gets no reply. Acceptable for read-only commands (user can retry).
