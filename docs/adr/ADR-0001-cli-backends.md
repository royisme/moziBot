---
Date: 2026-02-23
Status: Accepted
---

# ADR-0001: CLI Backends For Local Codex / Claude Code

## Context

We want Mozi to reuse local AI CLIs (Codex CLI, Claude Code CLI) as a reliable fallback
or primary provider without relying on API keys. OpenClaw supports this via CLI backends.

## Decision

Introduce a new CLI backend API (`cli-backend`) and a configuration block:

```
agents.defaults.cliBackends
```

Key points:

- Each backend is keyed by provider id (e.g. `claude-cli`, `codex-cli`).
- Models are exposed as `<provider>/<model>` and appear in `/models`.
- The CLI backend executes local commands, parses JSON/JSONL/text output, and returns
  text-only assistant responses.
- Sessions are kept in-memory per backend using the agent session id to preserve
  follow-up continuity.
- Built-in defaults are provided for `claude-cli` and `codex-cli`; users can override
  or add custom backends via config.

## Alternatives Considered

1. Use only API providers (OpenAI/Anthropic/Gemini).
   - Rejected: does not meet the "local CLI" requirement.
2. Bind directly to CLI tools outside the model registry.
   - Rejected: complicates fallback routing and `/models` introspection.

## Consequences / Tradeoffs

- CLI output is treated as text-only (no tool calls).
- Session ids are stored in-memory; continuity is lost after runtime restart.
- Some CLI output formats may require additional parsing improvements.

## Rollout / Migration

- Add `cliBackends` config for required CLI providers.
- Use model refs like `claude-cli/opus-4.6` or `codex-cli/gpt-5.2-codex`.

## Validation

- `pnpm run build`
