# Extensions Module (`src/extensions/`)

## Purpose

`src/extensions/` adds tool capabilities via builtin extensions and MCP servers.

## Key Files

- `loader.ts` - loads builtin extensions + initializes MCP async sources
- `registry.ts` - stores loaded extensions, tools, diagnostics
- `manifest.ts` - manifest validation
- `mcp/client-manager.ts` - MCP transport/tool adaptation
- `builtins/*` - bundled extension implementations

## Integration

Extension tools are merged into runtime tool surface via `AgentManager`.

## Edit + Verify

- `pnpm run test`
- `pnpm run check`
- test extension diagnostics and enable/disable flows

## Constraints

- Preserve manifest/schema validation and diagnostic reporting paths.
