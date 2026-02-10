# Container Module (`src/container/` + `src/runtime/sandbox/`)

## Purpose

Provides execution isolation for agent commands using Docker or Apple container runtime.

## Key Files

- `src/container/runtime.ts` - backend abstraction (`docker`/`apple`)
- `src/runtime/sandbox/service.ts` - session-scoped sandbox exec lifecycle
- `src/runtime/sandbox/bootstrap.ts` - probe/bootstrap dependency checks
- `src/runtime/sandbox/executor.ts` - sandbox executor wiring

## Integration

Runtime and agent manager use sandbox services/tools when mode requires isolation.

## Edit + Verify

- `pnpm run test`
- verify sandbox probe behavior and runtime startup messages

## Constraints

- Preserve clear failure hints when runtime backend is unavailable.
