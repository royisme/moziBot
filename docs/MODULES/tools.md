# Tools Module (`src/runtime/tools.ts`, `src/agents/tools/`, `src/extensions/`)

## Purpose

Mozi tool surface is composed from three sources:

1. Runtime-built tools (`src/runtime/tools.ts`)
2. Agent tool handlers/schemas (`src/agents/tools/*.ts`)
3. Extension/MCP tools (`src/extensions/*`)

## Tool Sources

### Runtime-Built Tools

- `createSubagentTool()`
- `createMemoryTools()`
- `createPiCodingTools()` (`read/edit/write/grep/find/ls`)
- `createExecTool()` (`src/runtime/sandbox/tool.ts`)

#### Exec + Secret Broker integration (implemented)

`exec` supports secret references via `authRefs`:

```json
{
  "command": "curl https://api.example.com",
  "authRefs": ["OPENAI_API_KEY"]
}
```

Runtime behavior:

- resolves each `authRef` via Secret Broker
- injects resolved values into tool execution env for that invocation only
- blocks protected direct env injection for names like `*_API_KEY`
- enforces `agents.<id>.exec.allowedSecrets` allowlist

### Agent Tool Definitions

- `src/agents/tools/sessions.ts` - sessions list/history/send/spawn/continuation
- `src/agents/tools/memory.ts` - memory search/get
- `src/agents/tools/bootstrap.ts` - bootstrap-file mutation helpers
- `src/agents/tools/browser.ts` - browser status/tabs + basic CDP actions (navigate/evaluate/click/type/screenshot)

### Extensions

- `src/extensions/loader.ts` - load builtin, external module, and MCP-backed extension sources
- `src/extensions/registry.ts` - collect enabled tools + diagnostics
- `src/extensions/mcp/client-manager.ts` - MCP transport and tool adaptation

## Runtime Assembly Path

Tool assembly is coordinated by `src/runtime/agent-manager.ts`:

- resolves allowlist / defaults
- merges runtime tools + memory + extensions + optional exec/sandbox
- sanitizes schemas for provider compatibility (`schema-sanitizer.ts`)

## Where to Edit

### Add a runtime tool

- Edit `src/runtime/tools.ts`
- Wire it in `AgentManager` tool build path
- Add tests + docs

### Add an extension tool source

- Edit `src/extensions/builtins/*`, add external module under `extensions.load.paths`, or add MCP config
- Ensure manifest validation passes
- Check diagnostics path in registry

### Change tool schema compatibility behavior

- Edit `src/runtime/schema-sanitizer.ts`
- Also inspect provider/model behavior in runtime tests

## Browser Tool

The `browser` tool provides a minimal CDP action surface for local Chrome via either:

- `driver=extension` (Chrome extension relay)
- `driver=cdp` (direct local CDP)

Supported actions:

- `status`, `tabs`
- `navigate` (requires `url`)
- `evaluate` (requires `expression`)
- `click` (requires `selector` or `x/y`)
- `type` (requires `text`, optional `selector` to focus)
- `screenshot` (optional `screenshot.format` + `screenshot.quality` for JPEG)

Notes:

- When `browser.defaultProfile` is not set and only one profile exists, the tool uses that profile automatically.
- The relay remains loopback-only and requires `browser.relay.authToken` when enabled.

## Verification

- `pnpm run test`
- Focus tests:
  - `src/runtime/schema-sanitizer.test.ts`
  - `src/agents/tools/*.test.ts`
  - `src/extensions/*.test.ts`
  - `src/runtime/agent-manager.tools.integration.test.ts`

## Constraints

- Keep tool names stable to avoid breaking existing prompts/runbooks.
- Any schema changes for tools should be tested against model/provider adapters.
