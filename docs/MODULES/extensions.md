# Extensions Module (`src/extensions/`)

## Purpose

`src/extensions/` provides a plugin-style extension runtime for tools, slash commands, and runtime hooks.
It supports three sources:

- Builtin extensions (`src/extensions/builtins/*`)
- External extension modules loaded from `extensions.load.paths`
- MCP-backed extensions loaded from `extensions.mcpServers`

## Key Files

- `loader.ts` - discovery, manifest normalization, config validation, allow/deny filtering
- `registry.ts` - extension registry + tool/hook/command collection and command execution
- `manifest.ts` - manifest validation and diagnostics
- `types.ts` - extension contract, register API, hook/command/tool types
- `mcp/client-manager.ts` - MCP transport/tool adaptation into extension records
- `builtins/*` - bundled extension implementations

## Extension Contract v2

An extension module exports a manifest object:

- Required: `id`, `version`, `name`
- Optional:
  - `tools[]`
  - `commands[]`
  - `hooks[]`
  - `register(api)` for dynamic registration
  - `configSchema` (`safeParse`, `validate`, or `parse`)
  - `capabilities` (`tools`, `commands`, `hooks`)
  - lifecycle callbacks: `onStart(ctx)`, `onStop(ctx)`, `onReload(ctx)`

`register(api)` can dynamically call:

- `api.registerTool(...)`
- `api.registerCommand(...)`
- `api.registerHook(...)`

`register(api)` is a synchronous load-path callback. Returning a `Promise` is rejected with deterministic diagnostics.

Supported runtime hook names:

- `before_agent_start`
- `before_tool_call`
- `after_tool_call`
- `before_reset`
- `turn_completed`

OpenClaw compatibility facade (minimal set):

- `before_agent_start` -> `before_agent_start`
- `before_tool_call` -> `before_tool_call`
- `after_tool_call` -> `after_tool_call`
- `before_reset` -> `before_reset`

OpenClaw hooks currently diagnosed as unsupported:

- `message_received`
- `message_sending`
- `before_message_write`
- `tool_result_persist`

Capability mismatch policy:

- `extensions.policy.capabilities = "warn" | "enforce"`
- `warn`: keep extension enabled and emit diagnostics
- `enforce`: disable extension when declared capabilities mismatch actual registrations

## Load & Enable Rules

- `extensions.enabled = false` disables the whole subsystem.
- `deny` has highest priority, then `allow`.
- Builtin extensions default to disabled unless explicitly enabled by entry.
- External modules discovered via `extensions.load.paths` default to enabled.
- Per-extension override is controlled by `extensions.entries.<id>.enabled`.

## Command Safety

- Command names are normalized to lower-case without leading `/`.
- Must match `^[a-z][a-z0-9_-]*$`.
- Reserved built-in command names are rejected.
- Duplicate extension command names are rejected with diagnostics.

## Runtime Integration

- `AgentManager` merges extension tools into runtime tool surface.
- Extension hooks are registered into runtime hook registry and re-synced on config reload.
- Host command flow dispatches unmatched slash commands to extension commands.

## OpenClaw Migration Case

`openclaw-memory-recall` is a builtin migration case from OpenClaw `extensions/memory-lancedb` (auto-recall path).

- Uses `register(api)` + `api.registerHook("before_agent_start", ...)`.
- Reads `MEMORY.md`, scores lines by prompt keyword overlap, and prepends a compact recall block to `promptText`.
- Kept intentionally lightweight: no vector DB, no embeddings, no async service bootstrap.

Key config fields (`extensions.entries.openclaw-memory-recall.config`):

- `baseDir` (default `~/.mozi`)
- `memoryFile` (default `MEMORY.md`)
- `maxItems` (default `3`)
- `maxInjectChars` (default `1200`)
- `minPromptChars` / `minLineChars`

Builtin style unification:

- Builtins use `register(api)` as the canonical behavior path.
- Deterministic startup is preserved via explicit imports in `src/extensions/builtins/index.ts`.

## Integration

The extension registry is used by runtime host and agent manager, so extension capabilities are available without separate wiring per adapter.

## Edit + Verify

- `pnpm run test`
- `pnpm run check`
- test extension diagnostics and enable/disable flows

## Constraints

- Preserve manifest/schema validation and diagnostic reporting paths.
- Keep extension reload behavior idempotent (no duplicate hooks/commands on reload).
