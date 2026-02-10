# Secret Broker (Single-DB, Runtime Built-In)

Status: Implemented (Phase 1 + Phase 2, local-first)  
Last Updated: 2026-02-10

## 1. Context

Mozi currently loads credentials from process environment and config-local `.env`.
This works for simple setups, but has limitations:

- No unified runtime API for credentials (`set/get/list/delete`).
- Missing-key UX is fragmented (tool fails without guided recovery).
- Generic tool execution can accidentally overexpose environment variables.
- Credential management is not modeled as first-class runtime capability.

At the same time, adding a new database for credentials increases operational complexity.
Mozi already has a primary database (`mozi.db`), so we should reuse it.

## 2. Decision Summary

Adopt a **runtime-built-in Secret Broker** with a **single database backend**:

- Control plane is built into runtime (commands, validation, injection policy).
- Storage uses existing `mozi.db` (no extra SQLite files).
- Future remote backends can be added behind a store interface, without changing runtime APIs.

This yields the best balance between security, simplicity, and cross-platform operability.

## 3. Goals and Non-Goals

### Goals

1. Cross-platform credential workflow (no OS-specific keychain dependency).
2. Unified command UX (`/setAuth`, `/unsetAuth`, `/listAuth`).
3. Least-privilege injection into tools at execution time.
4. No credential values in prompts, transcripts, or logs.
5. Reuse existing `mozi.db`.

### Non-Goals

1. Build distributed secret management in v1.
2. Integrate cloud KMS in v1.
3. Automatically import all host environment variables.

## 4. Architecture (Current)

### 4.1 Components

1. `SecretBroker` (runtime service)
   - Runtime API for credential lifecycle and resolution.
   - Enforces scope and policy checks.
2. `SecretStore` (data access layer)
   - Initial implementation backed by existing `mozi.db`.
   - Provides CRUD and usage metadata updates.
3. `SecretResolver` (execution-time injector)
   - Resolves required secrets for a tool call.
   - Injects temporary values into execution environment.
4. `AuthCommands` (chat command handlers)
   - `/setAuth`, `/unsetAuth`, `/listAuth`, `/checkAuth`.

### 4.2 High-Level Flow

1. User triggers tool/skill.
2. Runtime discovers `requiredSecrets` (declared by tool or skill adapter).
3. `SecretBroker.resolve()` fetches scoped values.
4. Missing secrets return typed error (`AUTH_MISSING`).
5. Message handler asks user to run `/setAuth KEY=VALUE`.
6. User sets credential once; runtime retries tool call.

## 5. Data Model (Reuse `mozi.db`)

Create table in existing DB migrations:

```sql
CREATE TABLE IF NOT EXISTS auth_secrets (
  name TEXT NOT NULL,
  scope_type TEXT NOT NULL DEFAULT 'global', -- global | agent
  scope_id TEXT NOT NULL DEFAULT '',         -- '' for global, agentId for agent scope
  value_ciphertext BLOB NOT NULL,
  value_nonce BLOB NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_used_at TEXT,
  created_by TEXT,
  PRIMARY KEY (scope_type, scope_id, name)
);

CREATE INDEX IF NOT EXISTS idx_auth_secrets_scope_name
  ON auth_secrets(scope_type, scope_id, name);
```

Notes:

- Uses one table only; no extra DB file.
- `scope_type=agent` enables per-agent secret isolation.
- `scope_id=''` is used for global scope rows.
- `last_used_at` is updated on successful resolution.

## 6. Security Model

### 6.1 Encryption

- Encrypt at rest before writing to DB.
- Master key source: `MOZI_MASTER_KEY` (required in production mode).
- Development fallback mode may exist but must be explicit and warned.

### 6.2 Least Privilege

- Tools declare required secret names.
- Runtime allows injection only for approved tool/agent combinations.
- Secrets are injected only for current tool execution lifecycle.

### 6.3 Redaction

- Never include secret values in:
  - prompts
  - session transcripts
  - logs
  - command echo output

### 6.4 Command Safety

- `/setAuth` input is parsed and stored securely; value is never reprinted.
- `/listAuth` shows metadata only (name/scope/updatedAt/lastUsedAt), no value.

## 7. Runtime Interfaces (Implemented)

```ts
export type SecretScope = { type: "global" } | { type: "agent"; agentId: string };

export interface SecretBroker {
  set(params: { name: string; value: string; scope: SecretScope; actor?: string }): Promise<void>;
  unset(params: { name: string; scope: SecretScope }): Promise<boolean>;
  list(params: {
    scope?: SecretScope;
  }): Promise<Array<{ name: string; scope: SecretScope; updatedAt: string; lastUsedAt?: string }>>;
  check(params: {
    name: string;
    agentId: string;
    scope?: SecretScope;
  }): Promise<{ exists: boolean; scope?: SecretScope }>;
}
```

Implementation note:

- `RuntimeSecretBroker.getValue(...)` exists for execution-time secret resolution (used by `exec` with `authRefs`).

## 8. Command UX

### 8.1 `/setAuth`

Examples:

- `/setAuth TAVILY_API_KEY=xxxx`
- `/setAuth OPENAI_API_KEY=xxxx --scope=global`
- `/setAuth BRAVE_API_KEY=xxxx --scope=agent:mozi`

Behavior:

- Parse key-value safely (single token `KEY=VALUE`).
- Store encrypted secret.
- Return success without exposing value.

Current parser supports:

- `/setAuth KEY=VALUE`
- `/setAuth set KEY=VALUE`

### 8.2 `/unsetAuth`

- `/unsetAuth TAVILY_API_KEY`
- `/unsetAuth TAVILY_API_KEY --scope=agent:mozi`

### 8.3 `/listAuth`

- `/listAuth`
- `/listAuth --scope=agent:mozi`

Only metadata is shown.

### 8.4 `/checkAuth`

- `/checkAuth TAVILY_API_KEY`

Returns whether secret exists for effective scope resolution.

## 9. Tool Integration Strategy

### 9.1 Built-In Tools

`requiredSecrets` metadata for non-`exec` tools is not implemented yet.

### 9.2 Generic `exec` Tool

To avoid broad secret exposure:

- Keep existing `env` argument for non-secret variables.
- Add `authRefs?: string[]` for secret references.
- Runtime resolves `authRefs` via broker and merges into execution env.
- Block direct passing of protected secret names via plain `env`.

Additional implemented guardrails:

- `authRefs` are checked against `agents.<id>.exec.allowedSecrets` (or defaults).
- If runtime auth is disabled, `authRefs` returns explicit guidance instead of silently failing.
- Missing referenced secret throws `AUTH_MISSING <KEY>` and is surfaced by message handler guidance.

## 10. Migration Plan

### Phase 1 (MVP) ✅ Completed

1. Add `auth_secrets` migration to existing DB.
2. Implement `SecretStore` + `SecretBroker` (sqlite backend only).
3. Implement `/setAuth`, `/unsetAuth`, `/listAuth`.
4. Integrate missing-secret error path into message handler.

### Phase 2 ✅ Completed

1. Add `requiredSecrets` metadata for built-in tools. (deferred)
2. Add `authRefs` support to `exec`.
3. Add policy config for tool-secret allowlist.

### Phase 3 (Deferred / Not in current local-first scope)

1. Add remote store adapter (`SecretStoreRemote`) behind same interface.
2. Keep runtime API unchanged.

## 11. Configuration (Current)

```jsonc
{
  "runtime": {
    "auth": {
      "enabled": true,
      "store": "sqlite",
      "masterKeyEnv": "MOZI_MASTER_KEY",
      "defaultScope": "agent",
    },
  },
}
```

Optional policy extension:

```jsonc
{
  "agents": {
    "mozi": {
      "exec": {
        "allowedSecrets": ["TAVILY_API_KEY", "BRAVE_API_KEY"],
      },
    },
  },
}
```

Recommendation:

- Keep secret names uppercase (`OPENAI_API_KEY`) for consistent `authRefs` resolution.

## 12. Observability

Add structured events:

- `auth.secret.set`
- `auth.secret.deleted`
- `auth.secret.resolve.success`
- `auth.secret.resolve.missing`
- `auth.secret.resolve.denied`

All events must be value-redacted.

## 13. Test Plan

1. DB migration test: table/index created in existing `mozi.db`.
2. Broker unit tests:
   - set/get/delete/list by scope
   - encryption/decryption
   - missing and denied cases
3. Command integration tests:
   - `/setAuth` success and parsing edge cases
   - `/listAuth` redaction
4. Tool execution tests:
   - injection works for declared refs
   - missing secret yields guided user message
   - secret not persisted in session transcript

## 14. Open Questions (Current)

1. Should `global` or `agent` be default scope for your production profile?
2. Should runtime support key rotation helper command in v1?
3. Should `/setAuth` allow multiline values (default: no)?

## 15. Rationale Recap

This design keeps implementation simple by reusing current infrastructure:

- no new sqlite file
- no OS lock-in
- no breaking tool interface changes required for MVP

It also keeps future extensibility by abstracting storage access while maintaining a stable runtime broker API.
