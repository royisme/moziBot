# Task 07: Model Configure Section

## Scope

Implement the `model` section that guides users through selecting and configuring models.

## Deliverables

### Files to create

- `src/configure/sections/model.ts`:
  - Implements `ConfigureSection` interface
  - `order: 20`
  - Flow:
    1. List configured providers (from config)
    2. Select provider → show known models for that provider
    3. Pick a known model or enter a custom model name
    4. Configure optional model settings such as context window, max tokens, input types
    5. Optionally set an alias
    6. Write to `config.models.providers[providerId].models[]` and optionally `config.models.aliases`
  - Known model source: each `ProviderFlow` may export an optional `knownModels: string[]` array; user may always enter a custom model name instead
  - Alias handling is intentionally simple in M1: `config.models.aliases` is a plain `Record<string, string>` such as `{ "default": "openai/gpt-4o", "fast": "openai/gpt-4o-mini" }`
  - No role-specific or agent-specific alias model routing in M1
  - Non-interactive mode: read model name from env and set it as a simple alias/default if requested
  - Concrete example after writing a model entry:
    ```jsonc
    "models": {
      "providers": {
        "openai": {
          "models": [
            {
              "id": "gpt-4o",
              "label": "GPT-4o"
            }
          ]
        }
      },
      "aliases": {
        "default": "openai/gpt-4o"
      }
    }
    ```

### Files to modify

- `src/configure/registry.ts`: register model section

## Acceptance Criteria

- Can select a model from a configured provider
- Can enter a custom model name
- Can set a model as the default alias
- Can assign model to a simple alias (for example `fast` or `default`)
- Model entries are written under `config.models.providers[providerId].models[]`
- Model entries are valid per the existing model schema
- `pnpm run check` passes

## Dependencies

- Task 01, 04, 05, 06 (needs providers configured first)
