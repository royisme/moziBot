# Task 06: Provider Configure Section

## Scope

Implement the `provider` section that guides users through adding/editing LLM providers.

## Deliverables

### Files to create

- `src/configure/sections/provider.ts`:
  - Implements `ConfigureSection` interface
  - `order: 10`
  - Flow:
    1. Show menu: "Add provider" / "Edit provider" / "Remove provider" / "Back"
    2. Add: select from `PROVIDER_FLOWS` → run flow → write provider config
    3. Edit: select existing provider → show editable fields list → modify selected field
    4. Remove: select existing provider → confirm → remove from config
  - API key storage design:
    - store API keys in `~/.mozi/.env` via `SecretManager`
    - write config to reference runtime env substitution using the provider env var name (for example `${OPENAI_API_KEY}`)
    - this must align with the existing runtime `ProviderRegistry.resolveApiKey()` behavior
  - For simple providers (`auth: 'api-key'`): prompt for API key → store via `SecretManager` → set provider config
  - For providers with `auth: 'none'` such as ollama: skip the API-key prompt entirely
  - For complex providers (`customFlow`): delegate to provider-specific flow
  - Edit flow shows an explicit field picker, at minimum: `baseUrl`, `headers`, `auth mode`
  - Non-interactive mode: read `MOZI_PROVIDER=openai` and the corresponding provider API key env var
  - Concrete config example after adding OpenAI:
    ```jsonc
    "providers": {
      "openai": {
        "id": "openai",
        "baseUrl": "https://api.openai.com/v1",
        "auth": "api-key"
        // apiKey resolved at runtime from OPENAI_API_KEY env var
      }
    }
    ```

### Files to modify

- `src/configure/registry.ts`: register provider section in `registerAllSections()`

## Acceptance Criteria

- Can add a new OpenAI provider with API key
- Can add a new Anthropic provider with API key
- Can add ollama provider without API key
- Can edit an existing provider's base URL and other supported fields via field selection
- Can remove a provider
- Provider entries are valid per `ModelProviderSchema`
- API keys stored via SecretManager in `~/.mozi/.env`, not in `config.jsonc`
- `pnpm run check` passes

## Dependencies

- Task 01, 02, 03, 04, 05
