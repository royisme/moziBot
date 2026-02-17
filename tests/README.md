# Tests Harness

`tests/harness/runtime-test-harness.ts` provides a shared runtime layout for integration tests.

## Goals

- Avoid ad-hoc `test-home`/`test-workspace` folders in the repo root.
- Avoid per-test random temp roots for core runtime behavior checks (for example `/new` greeting flow).
- Reuse the user's real config shape from `~/.mozi/config.jsonc` while keeping all test writes inside `tests/runtime/`.

## Behavior

`prepareRuntimeTestHarness()` loads base config using this order:

1. `baseConfigPath` argument (if provided)
2. `MOZI_TEST_CONFIG` environment variable (if set)
3. `~/.mozi/config.jsonc`
4. `release/config.example.jsonc` (fallback)

Then it rewrites runtime paths into `tests/runtime/<suiteId>/`:

- `home/`
- `workspace/`
- `sessions/`
- `logs/`

This keeps test output deterministic and easy to inspect.
