# Storage Module (`src/storage/`)

## Purpose

SQLite-backed persistence for sessions, runtime queue, messages, tasks, groups, and multimodal records.

## Key Files

- `db.ts` - connection pool init, schema setup, table access APIs

## Integration

Consumed by runtime host/kernel/session manager/multimodal ingest and diagnostics.

## Edit + Verify

- `pnpm run test`
- focus `src/storage/db.integration.test.ts`
- validate runtime queue/session behavior after schema/API edits

## Constraints

- High blast radius: changes may affect runtime startup, queue processing, and session persistence.
