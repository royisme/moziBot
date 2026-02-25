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

## Local Desktop Widget Mode

`channels.localDesktop.widget.mode` controls whether the desktop widget transport is started:

- `"auto"` (recommended default): start only when desktop environment is detected
- `"on"`: force start
- `"off"`: disable local desktop widget transport

Current precedence at runtime:

1. `MOZI_WIDGET_MODE` env override (`auto|on|off`)
2. `channels.localDesktop.widget.mode`
3. legacy `channels.localDesktop.enabled` (backward compatibility)
4. default fallback to `auto`

Headless override:

- `MOZI_WIDGET_HEADLESS=1` forces `auto` mode to resolve as disabled.

## Extensions Configuration

`src/config/schema/extensions.ts` defines extension runtime config:

- `extensions.enabled` - global switch.
- `extensions.allow[]` / `extensions.deny[]` - ID filtering (`deny` wins).
- `extensions.policy.capabilities` - capability mismatch behavior (`warn` or `enforce`).
- `extensions.load.paths[]` - file or directory paths for external extension module discovery.
- `extensions.entries.<extensionId>` - per-extension `enabled` and extension-owned `config`.
- `extensions.mcpServers.<serverId>` - MCP server process config (`command`, `args`, `env`, `enabled`, `timeout`).
- `extensions.installs.<extensionId>` - installation provenance metadata (currently not an auto-installer).

Recommended baseline for a new user config:

1. Set `extensions.enabled: true`.
2. Add `extensions.load.paths: ["~/.mozi/extensions"]`.
3. Create entries for builtin extensions you want to enable (for example `web-tavily`, `brave-search`, `openclaw-memory-recall`).
4. Keep `extensions.policy.capabilities: "warn"` for first rollout, then switch to `"enforce"` after extension manifests are fully declared.
5. Add `mcpServers` entries only for servers you actually use, keeping each one `enabled: false` until validated.

## Browser Configuration

`src/config/schema/browser.ts` defines browser relay and CDP profile settings:

- `browser.enabled` - master switch (defaults to enabled when unset).
- `browser.defaultProfile` - profile name used when the browser tool is called without an explicit profile.
- `browser.profiles.<name>` - profile definition:
  - `driver`: `extension` (Chrome extension relay) or `cdp` (direct CDP).
  - `cdpUrl`: loopback HTTP URL (e.g. `http://127.0.0.1:9222`).
- `browser.relay.enabled` - whether the local relay server can be started for extension profiles.
- `browser.relay.bindHost` - loopback bind host (`127.0.0.1` / `::1` / `localhost`).
- `browser.relay.port` - relay port. When set, extension profiles must match this port in `cdpUrl`.

Notes:

- If only one profile is defined and `browser.defaultProfile` is omitted, the browser tool will use that profile.
- Extension relay is **loopback-only** and requires a relay auth token.
- Direct CDP profiles are currently restricted to loopback URLs for safety.

## Relay Auth (Browser Relay)

`browser.relay.authToken` is required when `browser.relay.enabled=true` and any profile uses `driver=extension`.

The relay token is derived via HMAC (`sha256`) using the relay auth token plus the relay port.

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

### QMD Recall Quality (`memory.qmd.recall`)

Optional post-processing for QMD results:

- `mmr.enabled` (boolean, default `false`): Enable MMR reranking for diversity.
- `mmr.lambda` (number, default `0.7`): Relevance vs diversity trade-off.
- `temporalDecay.enabled` (boolean, default `false`): Apply recency decay for dated memory files.
- `temporalDecay.halfLifeDays` (number, default `30`): Score half-life in days.
- `metrics.enabled` (boolean, default `false`): Write recall metrics to `data/metrics/memory-recall.jsonl`.
- `metrics.sampleRate` (number, default `1`): Sampling rate for metrics logging (0-1).

## Edit + Verify

- After schema/default changes:
  - `pnpm run test`
  - `pnpm run check`
  - `pnpm run schema:check`

## Constraints

- Project is in active development stage: do not preserve backward compatibility unless explicitly required by task.
