# Task 05: Wizard Orchestrator and CLI Command

## Scope

Implement the wizard orchestrator (`runConfigureWizard`) and wire it into the CLI
as `mozi configure`.

## Deliverables

### Files to create

- `src/configure/context.ts`:
  - `createWizardContext(opts)` — loads config, creates SecretManager, creates WizardUI
  - If the config file does not exist, create a default `MoziConfig` skeleton in memory for first-time setup
  - `persist()` implementation — writes config back to the JSONC file
  - `persist()` uses `jsonc-parser` `modify()` + `applyEdits()` to preserve existing comments when the config file already exists
  - If the config file does not exist yet, `persist()` creates it from scratch with `JSON.stringify()`
  - `persist()` writes atomically: write to a temp file in the same directory, then rename into place
  - `persist()` writes directly without re-validating the full config; section implementations are responsible for schema-valid mutations

- `src/configure/index.ts`:
  - `runConfigureWizard(opts)` — the main orchestrator
  - Interactive menu loop with per-section persistence
  - Batch mode for `--section` flags
  - `WizardCancelledError` catch with partial-save messaging

- `src/cli/commands/configure.ts`:
  - Commander command definition
  - Options: `--section <name>` (repeatable), `--config <path>`, `--non-interactive`
  - Lazy-loads and calls `runConfigureWizard`
  - Follows the existing lazy-import command pattern already used in `src/cli/index.ts`

### Files to modify

- `src/cli/index.ts`:
  - Register the new `configure` command using the existing lazy-import style

## Acceptance Criteria

- `mozi configure` launches interactive wizard with section menu
- `mozi configure --section provider` runs only provider section
- `mozi configure --section provider --section model` runs both in order
- `mozi configure --non-interactive` skips prompts
- Ctrl+C at any point saves completed sections and exits cleanly
- Config is persisted as valid JSONC after each section while preserving existing comments where possible
- First-time setup works when the config file is missing
- `pnpm run check` passes

## Dependencies

- Task 01 (types/registry)
- Task 03 (SecretManager)
- Task 04 (WizardUI)
