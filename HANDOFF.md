# HANDOFF

## Current objective

Continue OpenClaw alignment beyond the contract layer. The provider/auth/model contract layer is now aligned.

This file is session-state transfer, not permanent architecture policy.

## What already landed

### Contract layer alignment (this session)

Five-phase alignment of provider contracts, auth resolution, credential management, and types:

1. **Centralized provider contract data** — Created `src/runtime/provider-env-vars.ts` (ported `PROVIDER_ENV_API_KEY_CANDIDATES` from upstream) and `src/runtime/provider-normalization.ts` (ported `normalizeProviderId()` with alias table). Refactored `src/runtime/providers/contracts.ts` to be self-contained. Fixed dependency inversion: runtime no longer imports from configure/.

2. **Aligned auth resolution** — Created `src/runtime/provider-auth.ts` with standalone `resolveApiKeyForProvider()` and `resolveProviderAuth()` matching upstream's resolution chain: config apiKey → SecretInput → env candidates → auth profiles → cli-credentials. `ProviderRegistry.resolveApiKey()` remains a thin delegate.

3. **Replaced Codex OAuth with CLI credential reading** — Created `src/runtime/cli-credentials.ts` (ported from upstream `cli-credentials.ts`: reads `~/.codex/auth.json`, macOS keychain fallback, TTL cache). Deleted `src/runtime/providers/auth.ts` (OAuth handler machinery). Updated `codex-oauth.ts` to check CLI credentials instead of running OAuth. Updated `codex-usage.ts` to use `readCodexCliCredentials()`. OAuth auth method now throws with "authenticate via native CLI" message.

4. **Aligned types** — `ProviderConfig` now includes `injectNumCtxForOpenAICompat`. `normalizeProviderId()` applied in `ProviderRegistry`, `ModelRegistry.parseRef()`, and `composeProvider()`. `ProviderContract` defined in `runtime/types.ts` as single source of truth. `ModelDefinition.name` kept optional (>10 call sites affected — TODO to tighten).

5. **Validated** — tsc clean, 1739/1739 tests pass, all old OAuth patterns removed, no configure/ imports in runtime/.

### Previous sessions

- Integrated provider onboarding as primary `configure` path.
- `mozi auth` aligned around shared provider contract.
- Shared secret loading/deletion fixes landed.
- Repo-wide TypeScript/test cleanup completed.

## Validation state

- `pnpm run check` ✅ (passed via pre-commit for commit `896c757`)
- `pnpm exec tsc --noEmit --pretty false` ✅ earlier in the session
- `pnpm run test` ✅ earlier in the session (agent reported full vitest pass: 171 files / 1761 tests)

### Provider transport refactor landed in `896c757`

**Bug / motivation:** runtime behavior was still partially inferred from provider `baseUrl` and mixed contract/runtime state. That let native SDK providers like `google` leak into the Pi OpenAI-compatible registration path, which caused the Google 404 regression.

**What landed:**
- `src/runtime/types.ts` — introduced `ProviderTransportKind = "openai-compat" | "native-sdk" | "cli-backend"` and `ResolvedProvider`
- `src/runtime/providers/contracts.ts` — now static contract metadata only; google marked `transportKind: "native-sdk"`
- `src/runtime/providers/composition.ts` — new contract+config composition pipeline producing `ResolvedProvider`
- `src/runtime/provider-registry.ts` — now stores resolved providers
- `src/runtime/providers/pi-registration.ts` — extracted PI registration logic; only registers `transportKind === "openai-compat"`
- `src/runtime/agent-manager.ts` — now orchestrates registration instead of encoding provider transport rules
- `src/runtime/cli-backends.ts` — Gemini CLI added as first-class `cli-backend` with `google-gemini-cli`

**Why this works:**
Transport routing is now explicit. Google keeps canonical metadata like `baseUrl`, but registration/routing decisions use `transportKind` instead of guessing from HTTP-looking config.

**Tests added/updated:**
- `src/runtime/providers/composition.test.ts`
- `src/runtime/providers/pi-registration.test.ts`
- `src/runtime/model-registry.test.ts`
- `src/runtime/cli-backends.test.ts`

## Intentionally incomplete

- `ModelDefinition.name` is still optional — needs tightening when call sites are updated
- Auth-profile failure rotation is currently wired only through the Codex default transport wrapper in `src/runtime/agent-manager.ts`; broader provider/runtime failure observation is still deferred
- `SecretInput` support for `ProviderConfig.headers` deferred — kept as `Record<string, string>` to avoid blast radius
- Model catalog / model selection alignment with upstream not yet done
- `configure/` layer still has its own flow abstractions that could be simplified now that runtime owns contract data

## New files created this session

- `src/runtime/provider-env-vars.ts` — centralized API key env var candidates
- `src/runtime/provider-normalization.ts` — provider ID normalization + alias table
- `src/runtime/provider-auth.ts` — standalone auth resolution function + source metadata
- `src/runtime/cli-credentials.ts` — Codex/Claude CLI credential reading
- `src/runtime/auth-profiles.ts` — auth-profile storage adapter, ordering, cooldown, lastGood/lastUsed tracking
- `src/runtime/auth-profiles.test.ts` — auth-profile ordering/cooldown tests

## Files deleted this session

- `src/runtime/providers/auth.ts` — OAuth handler machinery (replaced by cli-credentials.ts)

## Known pitfalls

- The pre-existing lint error in `execution-flow.test.ts` blocks `pnpm run check` — fix separately.
- `@mariozechner/pi-ai` typing is sensitive around `Model<TApi>`; prefer concrete API literals.
- Tests that replace runtime collaborators with mocks can hide new-method mismatches.

## Resume checklist for a fresh agent

Before changing code:
- read `CLAUDE.md`
- read `.claude/rules/workflow.md`
- read this file
- compare the local implementation against `../openclaw_source_github`

Then answer:
1. What is already done? (contract layer aligned)
2. What TODOs remain? (auth profiles, cli-credentials in resolution chain, ModelDefinition.name, headers SecretInput)
3. What upstream alignment comes next? (model selection, model catalog, configure simplification)
