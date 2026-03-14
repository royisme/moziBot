# Task 02: Provider Flow Registry and Shared ENV Constants

## Scope

Create the provider flow registry and extract the hardcoded ENV_MAP from
`src/runtime/provider-registry.ts` into a shared constant.

## Deliverables

### Files to create

- `src/configure/provider-flows/index.ts`:
  - `ProviderFlow` interface definition (moved from Task 01)
  - `PROVIDER_FLOWS: ProviderFlow[]` — declarative registry of all supported providers
  - `PROVIDER_ENV_MAP: Record<string, string>` — derived from `PROVIDER_FLOWS`, maps provider ID to env var name
  - Initial entries: `openai`, `openai-codex`, `anthropic`, `google`, `openrouter`, `ollama`
  - `ProviderFlow.auth` supports `'api-key' | 'token' | 'none'`; `ollama` uses `auth: 'none'` and skips API-key prompts entirely
  - Complete env mapping table:
    - `openai` → `OPENAI_API_KEY`
    - `openai-codex` → `OPENAI_API_KEY`
    - `anthropic` → `ANTHROPIC_API_KEY`
    - `google` → `GEMINI_API_KEY`
    - `openrouter` → `OPENROUTER_API_KEY`
    - `ollama` → `''`

- `src/configure/provider-flows/openai.ts` — OpenAI flow entry
- `src/configure/provider-flows/anthropic.ts` — Anthropic flow entry (with `customFlow` stub for token auth if needed)
- `src/configure/provider-flows/google.ts` — Google Gemini flow entry
- `src/configure/provider-flows/openrouter.ts` — OpenRouter flow entry
- `src/configure/provider-flows/ollama.ts` — Ollama flow entry (no API key needed, `auth: 'none'`, `apiEnvVar: ''`)

### Files to modify

- `src/runtime/provider-registry.ts`:
  - Remove hardcoded `ENV_MAP`
  - Import `PROVIDER_ENV_MAP` from `src/configure/provider-flows/index.ts`
  - Ensure `resolveApiKey()` still works identically
  - Import only the shared constant, not configure-only orchestration code

## Acceptance Criteria

- `PROVIDER_ENV_MAP` is the single source of truth for provider → env var mapping
- Runtime `ProviderRegistry.resolveApiKey()` behavior unchanged (test with existing tests)
- Each provider flow entry includes: `id`, `label`, `apiEnvVar`, `auth`, `defaultBaseUrl` where applicable
- `ollama` is represented with `auth: 'none'` and does not prompt for an API key
- `src/configure/provider-flows/` does not import from `src/runtime/` to avoid circular dependencies
- `pnpm run check` and `pnpm run test` pass

## Dependencies

- Task 01 (types)
