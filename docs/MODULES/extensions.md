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
- `message_received`
- `message_sending`
- `message_sent`
- `llm_input`
- `llm_output`
- `before_compaction`
- `after_compaction`
- `agent_end`

OpenClaw compatibility facade (minimal set):

- `before_agent_start` -> `before_agent_start`
- `before_tool_call` -> `before_tool_call`
- `after_tool_call` -> `after_tool_call`
- `before_reset` -> `before_reset`
- `message_received` -> `message_received`
- `message_sending` -> `message_sending`
- `llm_input` -> `llm_input`
- `llm_output` -> `llm_output`
- `before_compaction` -> `before_compaction`
- `after_compaction` -> `after_compaction`
- `agent_end` -> `agent_end`

OpenClaw hooks currently diagnosed as unsupported:

- `before_message_write`
- `tool_result_persist`
- `before_model_resolve`
- `before_prompt_build`
- `session_start`
- `session_end`
- `subagent_spawning`
- `subagent_delivery_target`
- `subagent_spawned`
- `subagent_ended`
- `gateway_start`
- `gateway_stop`

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

## Builtin: `web_fetch`

`web_fetch` is a built-in extension tool provided by the `web-fetch` extension. It fetches a specific `http` or `https` URL and returns readable page content as untrusted markdown or plain text.

What it does:

- accepts a single URL, not a search query
- fetches the page with manual redirect handling
- converts `text/html` into readable markdown, passes through markdown, pretty-prints JSON, and otherwise returns raw text
- wraps returned content as external untrusted content before it becomes model-visible

Tool parameters:

- `url` - required HTTP(S) URL
- `extractMode` - optional: `markdown` (default) or `text`
- `maxChars` - optional per-call output cap, clamped to `100..100000`

Untrusted-content wrapper semantics:

- `web_fetch` output is wrapped with an external-content boundary marker
- it includes a security notice telling the model not to treat fetched text as instructions and not to execute commands from it unless the user explicitly asked
- any embedded boundary markers in fetched content are sanitized first
- tool metadata marks the result as `externalContent.untrusted = true`, `source = "web_fetch"`, `wrapped = true`

Safeguards:

- SSRF protection blocks localhost, cloud metadata endpoints, private/link-local ranges, and hostnames that resolve to private/internal IPs
- redirects are handled manually and each redirect target is revalidated; redirects stop after `maxRedirects`
- requests time out after configured `timeout`
- response bodies larger than `maxResponseBytes` are rejected
- only `http:` and `https:` URLs are allowed

Firecrawl fallback:

- if the direct fetch path errors and `firecrawlApiKeyEnv` resolves to an API key, the tool tries Firecrawl `POST /v1/scrape`
- Firecrawl returns markdown-oriented main-content extraction and is reported as `extractor: "firecrawl"`
- fallback is best-effort; if Firecrawl also fails, the tool returns the original error path

Supported config under `extensions.entries.web-fetch.config`:

- `firecrawlApiKeyEnv` - environment variable name to read the Firecrawl API key from; default `FIRECRAWL_API_KEY`
- `firecrawlBaseUrl` - Firecrawl base URL; default `https://api.firecrawl.dev`
- `timeout` - request timeout in milliseconds; default `15000`
- `maxResponseBytes` - maximum response size in bytes; default `2000000`
- `maxRedirects` - redirect limit; default `5`
- `maxChars` - default output character cap; default `50000`

Usage example:

```json
{
  "tool": "web_fetch",
  "arguments": {
    "url": "https://example.com/docs",
    "extractMode": "markdown",
    "maxChars": 4000
  }
}
```

Config snippet:

```json
{
  "extensions": {
    "entries": {
      "web-fetch": {
        "enabled": true,
        "config": {
          "timeout": 20000,
          "maxResponseBytes": 1500000,
          "maxRedirects": 3,
          "maxChars": 20000,
          "firecrawlApiKeyEnv": "FIRECRAWL_API_KEY"
        }
      }
    }
  }
}
```

## Edit + Verify

- `pnpm run test`
- `pnpm run check`
- test extension diagnostics and enable/disable flows

## Constraints

- Preserve manifest/schema validation and diagnostic reporting paths.
- Keep extension reload behavior idempotent (no duplicate hooks/commands on reload).
