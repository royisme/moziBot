# Task 04: Tests and final validation

## Objective

Ensure all changes pass automated checks and add targeted unit tests for the bypass feature.

## Files

- Test files for `command-metadata.ts`, `enqueue-coordinator.ts`, `kernel.ts` (NEW or MODIFY existing test files)

## Steps

1. Add unit tests for `command-metadata.ts`:
   - `isBypassCommand` returns true for all bypass commands in the classification table
   - `isBypassCommand` returns false for `new`, `reset`, `compact`, `switch`, `reload`, `acp`
   - `isBypassCommand` returns false for unknown command names

2. Add/update unit tests for `enqueue-coordinator.ts`:
   - `handleStopCommand` sends confirmation via `channel.send()` when `channelRegistry` is provided
   - Confirmation text varies by `interrupted` count and `activeSessions` state
   - Graceful when `channelRegistry` is not provided (backwards compat)

3. Add/update unit tests for kernel bypass routing:
   - Bypass command is accepted without enqueue
   - Non-bypass command falls through (returns null)
   - Channel not found → falls through with warning log
   - `handle()` error is caught and logged, does not throw

4. Update any existing tests broken by `CommandHandlerMap` type change (Task 01 surface)

5. Run full validation:
   - `pnpm run check`
   - `pnpm run test`
   - `npx tsc --noEmit`

## Dependencies

- Requires Tasks 01, 02, 03 to be complete

## Risk

Low. Test-only changes. Main risk is discovering edge cases that require revisiting implementation tasks.
