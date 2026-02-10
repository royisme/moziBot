# CLI Module (`src/cli/`)

## Purpose

`src/cli/` is the operator and local-dev interface to Mozi runtime.

## Key Files

- `index.ts` - root command registration
- `runtime.ts` - runtime lifecycle commands (`start/stop/status/restart/install/logs`)
- `sandbox.ts` + `commands/sandbox.ts` - sandbox bootstrap checks/fixes
- `commands/init.ts` - project/home/workspace bootstrap
- `commands/config.ts`, `commands/health.ts`, `commands/extensions.ts`, `commands/auth.ts`

## Integration

CLI commands call into config loader, runtime lifecycle, memory diagnostics, and extension subsystems.

## Edit + Verify

- `pnpm run test`
- `pnpm run check`
- Validate impacted command manually (`mozi <cmd>`)

## Constraints

- Keep help text and command flags consistent across docs and runtime behavior.
