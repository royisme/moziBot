# Spec: Native SDK Provider Flag (`nativeSdk`)

## Problem Statement

`composeProvider()` in `src/runtime/providers/contracts.ts` (line 509) contains a hardcoded string check:

```ts
baseUrl: entry.baseUrl ?? (contract?.canonicalApi === "google-generative-ai" ? undefined : contract?.canonicalBaseUrl),
```

This was introduced as a hotfix because `@ai-sdk/google` manages its own endpoint internally. If `baseUrl` is populated, `resolvePiProviderRegistration()` in `src/runtime/agent-manager.ts` (line 324) treats the provider as an OpenAI-compatible Pi provider and registers it — causing OpenAI-style HTTP requests to be sent to `generativelanguage.googleapis.com`, which returns 404.

The hardcode is fragile because:
- Any new native SDK provider (e.g., `@ai-sdk/anthropic` used directly, or a future `@ai-sdk/mistral`) requires another `canonicalApi ===` string check.
- The intent — "this provider's SDK owns the transport, don't inject a baseUrl" — is not encoded in the type; it only exists as a comment-less string comparison.
- `canonicalBaseUrl` on the google contract (`https://generativelanguage.googleapis.com`) is also misleading: it documents the real endpoint but is never meant to be used as a `baseUrl` in provider registration.

## Proposed Change

### 1. Add `nativeSdk?: true` to `ProviderContract` (in `src/runtime/types.ts`)

```ts
export type ProviderContract = {
  id: string;
  canonicalApi?: ModelApi;
  canonicalBaseUrl?: string;
  canonicalHeaders?: Record<string, string>;
  nativeSdk?: true;           // <-- new field
  auth?: ModelProviderAuthMode;
  authModes?: ModelProviderAuthMode[];
  apiEnvVar?: string;
  catalog?: ModelDefinition[];
};
```

The type is `true` (not `boolean`) so omitting it is the same as `false`, avoiding any need for explicit `nativeSdk: false` on every other provider.

### 2. Mark the google contract seed with `nativeSdk: true` (in `src/runtime/providers/contracts.ts`)

In `PROVIDER_CONTRACT_SEEDS`, the `google` entry (around line 133) becomes:

```ts
google: {
  id: "google",
  canonicalApi: "google-generative-ai",
  canonicalBaseUrl: "https://generativelanguage.googleapis.com",
  nativeSdk: true,
  auth: "api-key",
  authModes: ["api-key"],
  catalog: [...],
},
```

### 3. Replace the hardcoded check in `composeProvider()` (line 509)

Before:
```ts
baseUrl: entry.baseUrl ?? (contract?.canonicalApi === "google-generative-ai" ? undefined : contract?.canonicalBaseUrl),
```

After:
```ts
baseUrl: entry.baseUrl ?? (contract?.nativeSdk ? undefined : contract?.canonicalBaseUrl),
```

No other changes needed in `composeProvider()`. The field propagates automatically via `{ ...seed }` spread in the `PROVIDER_CONTRACTS` map builder (lines 403–419), so `nativeSdk` on the seed will appear on the materialized `ProviderContract`.

## Files to Modify

| File | Change |
|---|---|
| `src/runtime/types.ts` | Add `nativeSdk?: true` to `ProviderContract` type (line ~33) |
| `src/runtime/providers/contracts.ts` | Add `nativeSdk: true` to `google` seed (line ~137); update `composeProvider` baseUrl line (line 509) |

No changes required in `src/runtime/agent-manager.ts`. The fix is upstream: the google provider will have no `baseUrl` after composition, so `resolvePiProviderRegistration()` returns `null` at line 324 (`if (!provider?.baseUrl)`) before it can incorrectly register.

## Acceptance Criteria

1. `npx tsc --noEmit` passes with no new errors.
2. `pnpm run check` passes.
3. `pnpm run test` passes.
4. A composed google provider has `baseUrl: undefined` when no `entry.baseUrl` is set in user config.
5. A composed google provider where the user explicitly sets `baseUrl` in config still uses that value (user override is preserved).
6. All other providers with `canonicalBaseUrl` and no `nativeSdk` flag still receive `baseUrl` from `canonicalBaseUrl` as before (no regression).

## Risk Assessment

**Low risk.** The change is purely additive on the type and replaces one narrowly scoped runtime check with an equivalent one.

- **Other providers unaffected:** Every provider except `google` has `nativeSdk` omitted (falsy), so the `??` fallback to `canonicalBaseUrl` is identical to before.
- **`canonicalBaseUrl` on google remains:** It is still useful as documentation and for display (e.g., provider info commands). Keeping it does not affect correctness since `nativeSdk: true` suppresses its injection into `baseUrl`.
- **User-set `baseUrl` is preserved:** The `entry.baseUrl ??` short-circuit means an explicit user config always wins, so a user who manually points google at a custom proxy is unaffected.
- **No Pi registration risk:** With `baseUrl: undefined`, `resolvePiProviderRegistration()` returns `null` immediately. The google provider will not appear in the Pi registry.
- **No providers currently depend on `google` having `baseUrl` injected:** The existing hotfix already suppresses it; this change is a clean replacement of that suppression.
