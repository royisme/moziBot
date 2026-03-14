# Task 03: SecretManager Interface and Implementation

## Scope

Create a unified SecretManager with pluggable backends, placed in `src/storage/secrets/`.

## Deliverables

### Files to create

- `src/storage/secrets/types.ts`:
  - `SecretScope` type (`global` | `agent` with `agentId`)
  - `SecretManager` interface (get, getEffective, set, delete, list, has)
  - `SecretBackend` interface (for pluggable backends)
  - Scope mapping rules:
    - `SecretScope.type: 'global'` ↔ `scopeType: 'global', scopeId: ''`
    - `SecretScope.type: 'agent', agentId: X` ↔ `scopeType: 'agent', scopeId: X`

- `src/storage/secrets/env-backend.ts`:
  - Reads/writes `.env` file at `~/.mozi/.env`
  - Implements `SecretBackend`
  - Handles file creation if not exists
  - Supports both global and agent-scoped secrets
  - Key naming rules:
    - Global secrets: flat `KEY=value` (example: `OPENAI_API_KEY=sk-xxx`)
    - Agent-scoped secrets: `MOZI_AGENT_{agentId}_KEY=value`
  - Atomic writes: write to a temp file in the same directory, then `fs.rename()` into place

- `src/storage/secrets/sqlite-backend.ts`:
  - Read-only bridge to existing `src/storage/repos/auth-secrets.ts`
  - Implements `SecretBackend`
  - Maps existing `scopeType: 'global' | 'agent'` to `SecretScope`
  - `set()` and `delete()` throw `Error('SQLite backend is read-only in M1')`

- `src/storage/secrets/manager.ts`:
  - Composite `SecretManager` implementation
  - Write operations → env backend
  - Read operations → cascade across both backends
  - `getEffective(key, agentId)` checks in this exact order:
    1. Agent scope in env backend
    2. Global scope in env backend
    3. Agent scope in sqlite backend
    4. Global scope in sqlite backend
    5. First non-null value wins

## Acceptance Criteria

- `SecretManager` can read secrets from both `.env` and SQLite stores
- `getEffective()` cascading follows the exact priority order above
- Write operations persist to `~/.mozi/.env` file
- `.env` backend supports both global and agent-scoped naming formats
- SQLite backend is read-only in M1 and throws on mutation methods
- Existing `auth-secrets.ts` is not modified, only read
- Unit tests for: get/set/delete, cascading resolution, backend fallback
- `pnpm run check` and `pnpm run test` pass

## Dependencies

- Task 01 (types reference)
