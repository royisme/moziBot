# Agents Module (`src/agents/`)

## Purpose

`src/agents/` defines agent identity/context files, workspace context loading, skill loading, and agent-side tool definitions used by runtime wiring.

Core files:

- `src/agents/home.ts` - home bootstrap + identity context assembly (`AGENTS.md`, `SOUL.md`, `IDENTITY.md`, `USER.md`, `MEMORY.md`, `HEARTBEAT.md`, `BOOTSTRAP.md`)
- `src/agents/workspace.ts` - workspace context and `TOOLS.md`
- `src/agents/skills/loader.ts` - skill discovery/loading/usage indexing
- `src/agents/tools/*.ts` - session and memory tool schemas/handlers

## Bootstrap & Identity Pattern

Agent bootstrap behavior is file-driven:

- Detect `BOOTSTRAP.md` on first-run style flows
- Build home context from canonical files
- Use `buildContextWithBootstrap()` when bootstrap file exists

This mirrors OpenClaw-style bootstrap conventions and enables self-bootstrap via repository files.

Language guidance is now explicit in templates:

- `IDENTITY.md` supports `Preferred Language` (for example `zh-CN`, `en`)
- `USER.md` supports preferred reply language
- bootstrap tool `update_identity` accepts optional `preferredLanguage`

This is used by `/new` greeting fallback language selection.

## Runtime Integration Points

Most runtime integration is in `src/runtime/agent-manager.ts`:

- Loads home/workspace context from `src/agents/*`
- Loads skills via `SkillLoader`
- Wires agent tools + extensions + memory into agent session

If you edit agent context behavior, inspect `AgentManager` in parallel.

## Where to Edit

### Add or adjust home identity files

- Edit: `src/agents/home.ts`
- Also inspect:
  - `src/agents/templates/*`
  - `src/cli/commands/init.ts` (seeding)

### Add or adjust workspace context rules

- Edit: `src/agents/workspace.ts`
- Also inspect:
  - `src/agents/templates/TOOLS.md`
  - `src/runtime/agent-manager.ts`

### Add agent-side tool schema/handler

- Edit: `src/agents/tools/*.ts`
- Also inspect:
  - `src/runtime/tools.ts` (runtime agent tool adaptation)
  - `src/runtime/host/tools/sessions.ts`

### Change skill loading policy

- Edit: `src/agents/skills/loader.ts`
- Also inspect:
  - `src/config/schema/skills.ts`
  - `src/runtime/agent-manager.ts`

## Verification

- `pnpm run test`
- `pnpm run check`
- `pnpm run test:integration`
- Targeted tests:
  - `src/agents/runner.test.ts`
  - `src/agents/tools/*.test.ts`
  - `src/agents/skills/*.test.ts`
  - `src/agents/workspace.integration.test.ts`
  - `src/runtime/host/message-handler/services/session-control-command.integration.test.ts`

Shared integration runtime harness:

- `tests/harness/runtime-test-harness.ts`
- `tests/runtime/` (generated per-suite test data, gitignored except `.gitkeep`)

## Constraints

- Keep home/workspace context file names stable unless you also migrate templates + init + loader code.
- Skill loader behavior affects prompt surface and tool visibility; validate enable/allow lists.
