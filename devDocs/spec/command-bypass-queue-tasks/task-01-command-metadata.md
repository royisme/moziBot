# Task 01: Create command-metadata.ts and refactor CommandHandlerMap

## Objective

Establish the single source of truth for command bypass classification and update the type system.

## Files

- `src/runtime/host/message-handler/services/command-metadata.ts` (NEW)
- `src/runtime/host/message-handler/services/command-handlers.ts` (MODIFY)
- `src/runtime/host/message-handler/services/command-map.ts` (MODIFY)
- `src/runtime/host/message-handler/services/command-map-builder.ts` (MODIFY)

## Steps

1. Create `command-metadata.ts` with `COMMAND_METADATA` record and `isBypassCommand()` helper (see spec Step 4).

2. In `command-handlers.ts`:
   - Add `CommandRegistration` interface: `{ handler: CommandHandler; bypassQueue?: boolean }`
   - Change `CommandHandlerMap` value type from `CommandHandler` to `CommandRegistration`
   - Update `dispatchParsedCommand` to unwrap `registration.handler` before calling

3. In `command-map.ts` / `command-map-builder.ts`:
   - Update all handler registrations to use `{ handler: fn, bypassQueue: true/false }` shape
   - Import bypass metadata from `command-metadata.ts` to tag each command

4. Update all call sites that build or consume `CommandHandlerMap` (tests, mocks, etc.)

## Validation

- `npx tsc --noEmit` passes (type changes are the main risk here)
- `pnpm run test` passes
- Unit test: `isBypassCommand("tasks") === true`, `isBypassCommand("new") === false`

## Dependencies

None — this task can be done first.

## Risk

Moderate refactor surface: `CommandHandlerMap` type change affects all consumers. Grep for `CommandHandlerMap` and `dispatchParsedCommand` to find all call sites.
