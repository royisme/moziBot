# Config Module (`src/config/`)

## Purpose

`src/config/` loads, resolves, validates, and defaults Mozi configuration.

## Key Files

- `loader.ts` - `loadConfig()`, env expansion, include processing, defaults
- `schema/index.ts` - `MoziConfigSchema` root
- `schema/*` - domain schemas (`models`, `agents`, `channels`, `runtime`, `memory`, `extensions`, `skills`, `sandbox`, `voice`)
- `env.ts` - `${VAR}` replacement
- `includes.ts` - `$include` expansion

## Integration

Used by CLI and RuntimeHost startup/reload. Invalid config is a startup blocker.

## Session Lifecycle Config (agents)

## Agent Model Config (current)

User-facing agent model config supports:

- `agents.defaults.model` (string or `{ primary, fallbacks }`)
- `agents.defaults.imageModel` (string or `{ primary, fallbacks }`, optional)
- Per-agent overrides with the same shape under `agents.<agentId>.model` and `agents.<agentId>.imageModel`

Notes:

- Legacy nested route shape (`model.routes.*`) is invalid.
- Non-image multi-format inputs route through multimodal ingestion + media-understanding pipeline.

`src/config/schema/agents.ts` supports lifecycle policy under both `agents.defaults` and agent entry level:

- `lifecycle.control.model` - control-plane model for lifecycle decisions
- `lifecycle.control.fallback[]` - deterministic fallback candidates
- `lifecycle.temporal.enabled`
- `lifecycle.temporal.activeWindowHours`
- `lifecycle.temporal.dayBoundaryRollover`
- `lifecycle.semantic.enabled`
- `lifecycle.semantic.threshold` (0..1)
- `lifecycle.semantic.debounceSeconds`
- `lifecycle.semantic.reversible`

Precedence for control model resolution:

1. session metadata override (`metadata.lifecycle.controlModel`)
2. agent-level lifecycle control model
3. defaults-level lifecycle control model
4. sorted deduplicated fallback list
5. agent primary reply model
6. first available model from model registry (sorted)

## Memory Configuration

`src/config/schema/memory.ts` defines how Mozi retrieves and persists long-term memory.

### Global Memory Settings

- `memory.backend` - `"builtin"` (default) or `"qmd"`
- `memory.citations` - `"auto"` (default), `"always"`, or `"never"`

### Builtin Memory Sync (`memory.builtin.sync`)

Controls the lifecycle of the local trigram-search index:

- `onSessionStart` (boolean, default `true`): Reindex when agent starts.
- `onSearch` (boolean, default `true`): Reindex before searching if files changed.
- `watch` (boolean, default `true`): Watch `MEMORY.md` and `memory/` for changes.
- `watchDebounceMs` (number, default `1500`): Debounce watcher triggers.
- `intervalMinutes` (number, default `0`): Background periodic sync (0 to disable).
- `forceOnFlush` (boolean, default `true`): Force reindex after history flush.

These flags are enforced by the runtime memory lifecycle orchestrator (`src/memory/lifecycle-orchestrator.ts`) rather than ad-hoc call sites, so session-start/search/flush behavior is consistent across runtime paths.

### Memory Persistence (`memory.persistence`)

Controls how session history is archived into memory files:

- `enabled` (boolean, default `false`): Master switch for auto-archiving.
- `onOverflowCompaction` (boolean, default `true`): Archive on context overflow.
- `onNewReset` (boolean, default `true`): Archive when `/new` is called.
- `maxMessages` (number, default `12`): Context retention count after archive.
- `maxChars` (number, default `4000`): Context retention char count after archive.
- `timeoutMs` (number, default `1500`): Max time allowed for flush operation.

### QMD Reliability (`memory.qmd.reliability`)

- `maxRetries` (number, default `2`): Retries for failed `qmd update` / `qmd embed`.
- `retryBackoffMs` (number, default `500`): Backoff step between retries.
- `circuitBreakerThreshold` (number, default `3`): Consecutive failures before opening circuit.
- `circuitOpenMs` (number, default `30000`): Time to keep circuit open.

Circuit-open state is exposed in provider status (`custom.qmd.reliability`) and is used by fallback memory routing to avoid repeatedly failing QMD searches.

## Edit + Verify

- After schema/default changes:
  - `pnpm run test`
  - `pnpm run check`
  - `pnpm run schema:check`

## Constraints

- Project is in active development stage: do not preserve backward compatibility unless explicitly required by task.
