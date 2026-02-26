# ADR-0002: Align Session Transcripts with pi SessionManager

- Date: 2026-02-26
- Status: Accepted

## Context

Mozi previously persisted session transcripts via `SessionStore` by writing a legacy JSONL format directly. This diverged from pi `SessionManager`, which manages session history as an append-only tree with compaction metadata and branching semantics. We want Mozi to align with the pi session format (as in OpenClaw) while preserving Mozi’s existing session paths and avoiding risky migrations.

## Decision

- New sessions use pi `SessionManager` for transcript persistence (JSONL tree format).
- `SessionStore` remains the mapping layer (`sessionKey` → `sessionFile`/metadata).
- `SessionStore` stores `sessionFormat` metadata (`pi` or `legacy`) to distinguish formats.
- Existing sessions are **not migrated**; only newly created sessions default to `pi`.
- Session file paths remain `sessions/<agentId>/<sessionId>.jsonl` (no `~/.pi` paths).
- Session transcript updates emit events; QMD memory sync is scheduled from these events when session export is enabled.

## Alternatives Considered

1. **Migrate all legacy transcripts to pi format**
   - Rejected due to high risk, complexity, and potential data loss.
2. **Keep legacy transcript format**
   - Rejected because it diverges from pi and complicates future compaction/branch features.
3. **Store pi sessions under a new path (e.g., `~/.pi`)**
   - Rejected to preserve Mozi’s current path conventions and operational consistency.

## Consequences / Tradeoffs

- Legacy and pi transcripts will coexist; some legacy behaviors (e.g., rollback merge) are retained only for legacy format.
- pi transcript persistence respects `SessionManager` flush rules (entries may not be written until an assistant message occurs).
- Memory indexing for sessions is debounced via transcript update events rather than immediate per-message reindexing.

## Rollout / Migration

- No migration. Existing sessions remain legacy.
- New sessions are marked `sessionFormat: "pi"` in `sessions.json`.

## Validation

- `pnpm run test src/runtime/session-store.test.ts`
- `pnpm run test src/memory/qmd-manager.search.test.ts`
