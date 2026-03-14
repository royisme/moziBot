# Task 04: WizardUI Implementation

## Scope

Implement the WizardUI abstraction layer wrapping an interactive prompt library.

## Deliverables

### Files to create

- `src/configure/ui.ts`:
  - `WizardCancelledError` class
  - `WizardUI` interface implementation using `@inquirer/prompts` (already present in `package.json`)
  - All methods: `intro`, `outro`, `text`, `confirm`, `select`, `multiselect`, `password`, `spinner`, `note`, `warn`, `error`
  - Cancel detection: wraps library cancellation into `WizardCancelledError`
  - Non-interactive behavior:
    - `text()` and `password()` accept an optional `envVar` string
    - if `nonInteractive` is true and `envVar` is provided, read from `process.env[envVar]`
    - if `nonInteractive` is true and the required env var is missing, throw a descriptive error naming the missing variable
    - `select()` returns the first option
    - `confirm()` returns `true`
  - Method contract clarity:
    - `intro`, `outro`, `note`, `warn`, and `error` are synchronous and return `void`
    - prompt methods return `Promise`s

## Acceptance Criteria

- All prompt methods correctly throw `WizardCancelledError` on user cancel
- Spinner works for async validation steps
- Password input masks characters
- Non-interactive mode: `text()`/`password()` read from env vars when `envVar` is provided, otherwise throw descriptive errors; `select()` uses first option; `confirm()` returns `true`
- Visual output is clean and consistent (test manually in terminal)
- `pnpm run check` passes

## Dependencies

- Task 01 (types)
