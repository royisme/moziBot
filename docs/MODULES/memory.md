# Memory Module (`src/memory/` + `src/storage/`)

## Purpose

Memory in Mozi combines:

1. Search/retrieval backends (`src/memory/`)
2. Persistent runtime/session/multimodal storage (`src/storage/db.ts`)

This module powers memory tools (`memory_search`, `memory_get`) and long-term context support.

## Key Components

### Retrieval Backends (`src/memory/`)

- `index.ts` - `getMemoryManager()` factory + cache
- `qmd-manager.ts` - QMD backend integration
- `builtin-manager.ts` - local fallback backend with trigram FTS5 support
- `fallback-manager.ts` - primary/fallback composition
- `backend-config.ts` - per-agent memory backend resolution

### Builtin Memory Lifecycle & Sync

The `builtin` memory backend supports automated synchronization of local `.md` files into a SQLite-backed search index.

#### Sync Triggers
- **Session Start**: Syncs when an agent session is warmed up.
- **On Search**: Ensures index is fresh before executing a search if it's marked as dirty.
- **Watch**: Filesystem watcher (chokidar) detects changes to `MEMORY.md` or `memory/` directory.
- **Interval**: Periodic background sync.
- **Flush**: When session history is flushed to memory files (e.g., on segment rotation or context overflow), the index can be forcefully updated.

### Lifecycle Orchestrator

`src/memory/lifecycle-orchestrator.ts` centralizes memory sync event handling.

- `session_start` → optional sync (`memory.builtin.sync.onSessionStart`)
- `search_requested` → optional dirty-check sync (`memory.builtin.sync.onSearch`)
- `flush_completed` → dirty mark and optional force sync (`memory.builtin.sync.forceOnFlush`)

The orchestrator coalesces in-flight sync requests and preserves force-sync requests queued while another sync is running, reducing duplicate work and preventing lifecycle trigger races.

### Persistence Layer (`src/storage/`)

- `db.ts` - SQLite schema + data access for sessions/queue/messages/multimodal
- Exposes table operations for runtime, sessions, tasks, multimodal records

## Configuration

Memory configuration is defined in `src/config/schema/memory.ts`.

### Builtin Sync Options (`memory.builtin.sync`)

| Key | Default | Description |
|-----|---------|-------------|
| `onSessionStart` | `true` | Trigger sync when session starts. |
| `onSearch` | `true` | Trigger sync before search if dirty. |
| `watch` | `true` | Enable filesystem watcher for `MEMORY.md` and `memory/`. |
| `watchDebounceMs` | `1500` | Debounce time for filesystem watcher. |
| `intervalMinutes` | `0` | Periodic sync interval in minutes (0 to disable). |
| `forceOnFlush` | `true` | Force reindex immediately after a memory flush. |

### QMD Reliability (`memory.qmd.reliability`)

Phase 3 adds bounded retry and circuit-breaker controls to QMD update/embed execution.

| Key | Default | Description |
|-----|---------|-------------|
| `maxRetries` | `2` | Retry attempts for failed `qmd update/embed` operations. |
| `retryBackoffMs` | `500` | Linear backoff per retry attempt. |
| `circuitBreakerThreshold` | `3` | Consecutive update failures before opening circuit. |
| `circuitOpenMs` | `30000` | Circuit-open duration before allowing update attempts again. |

When the circuit is open, QMD update calls are skipped (unless forced). In fallback mode, a circuit-open QMD status can preemptively route searches to builtin memory.

### Memory Persistence (`memory.persistence`)

| Key | Default | Description |
|-----|---------|-------------|
| `enabled` | `false` | Enable session history flushing to memory files. |
| `onOverflowCompaction` | `true` | Flush history to memory when context overflow occurs. |
| `onNewReset` | `true` | Flush history to memory when `/new` is called. |
| `maxMessages` | `12` | Max messages to retain in context after flush. |
| `maxChars` | `4000` | Max characters to retain in context after flush. |

## Integration Points

- `src/runtime/agent-manager.ts` requests memory manager for per-session tools.
- `src/runtime/tools.ts` creates runtime memory tool wrappers.
- `src/multimodal/ingest.ts` persists normalized multimodal envelopes into db tables.
- `src/runtime/host/message-handler.ts` manages lifecycle triggers for flush and sync.

## Where to Edit

### Change memory backend selection logic

- Edit: `src/memory/backend-config.ts`, `src/memory/index.ts`
- Also inspect:
  - `src/config/schema/memory.ts`
  - runtime tool wiring in `src/runtime/tools.ts`

### Change memory search/read semantics

- Edit: `src/memory/*manager*.ts`, `src/agents/tools/memory.ts`
- Also inspect:
  - `src/runtime/agent-manager.ts`

### Change persistent schema/table behavior

- Edit: `src/storage/db.ts`
- Also inspect all consumers (`runtime`, `host/sessions`, `multimodal`)

## Verification

- `pnpm run test`
- Focus tests:
  - `src/memory/*.test.ts`
  - `src/storage/db.integration.test.ts`
  - `src/multimodal/*.test.ts`

## Constraints

- `db.ts` is shared infrastructure; schema/field changes have broad blast radius.
- Keep memory manager cache invalidation behavior in sync with runtime reload paths.
