# Task 08: Secrets Configure Section

## Scope

Implement the `secrets` section for managing API keys and credentials.

## Deliverables

### Files to create

- `src/configure/sections/secrets.ts`:
  - Implements `ConfigureSection` interface
  - `order: 30`
  - Flow:
    1. List all secrets (masked display)
    2. Menu: "Add secret" / "Update secret" / "Delete secret" / "Validate secrets" / "Back"
    3. Add: enter key name + value → store via `SecretManager`
    4. Update: select existing → enter new value
    5. Delete: select existing → confirm → delete
    6. Validate: for each secret linked to a provider, attempt a lightweight API call to verify
  - Provider-secret linking uses `PROVIDER_ENV_MAP` from Task 02; if a secret key matches any env var value in that map, treat it as linked to that provider
  - Show which config fields reference each secret by scanning config for `${VAR_NAME}` patterns and matching them against known secret keys
  - Validation endpoint table:
    - OpenAI: `GET /v1/models`
    - Anthropic: `GET /v1/models` with `x-api-key` header
    - Google: `GET /v1beta/models` with `key` query param
    - OpenRouter: `GET /api/v1/models`
    - Ollama: `GET /api/tags` (local, no key needed)
  - Masking algorithm:
    - if value length is 10 or more: first 3 chars + `...` + last 4 chars
    - if value length is under 10: first 2 chars + `...` + last 2 chars

### Files to modify

- `src/configure/registry.ts`: register secrets section

## Acceptance Criteria

- Can list all secrets from both `.env` and SQLite backends with consistent masking
- Can add/update/delete secrets
- Validation uses the provider-specific lightweight endpoint table above
- Validation failures show clear error messages and do not crash the wizard
- Secret references are traced from `${VAR_NAME}` config patterns
- `pnpm run check` passes

## Dependencies

- Task 01, 03, 04, 05
