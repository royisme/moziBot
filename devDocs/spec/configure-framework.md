# Configure Framework

## Status: Draft

## Problem

moziBot lacks an interactive configuration system. Users cannot:
- Set up LLM providers and API keys through a guided flow
- Manage secrets in a unified way
- Configure models with provider-specific options

OpenClaw has this capability via `configure wizard`, but its implementation uses
imperative if/else dispatching per section — not easily extensible.

## Goal

Design a **section-based configure framework** that:
1. Supports incremental section migration from openclaw
2. Allows new sections to be added with minimal wiring
3. Integrates with the existing config loader, Zod schema, and CLI
4. Provides both interactive (wizard) and non-interactive (CLI flag) modes

## Non-Goals (for now)

- Gateway/daemon configuration
- Channel linking (WhatsApp/Telegram)
- Skills management
- Health checks
- Web tools configuration (Brave/Tavily/Perplexity — planned for Milestone 2)

These will be added as future sections using the same framework.

## Milestone Roadmap

- **Milestone 1**: Framework core + Provider + Model + Secrets sections
- **Milestone 2**: Web tools + `mozi auth` command consolidation
- **Milestone 3**: Gateway/daemon, channels, skills, health

---

## Architecture

### Core Concepts

```
┌─────────────────────────────────────────────┐
│              configure wizard                │
│  (orchestrator: menu loop / batch pipeline)  │
└──────────┬──────────────────────────────────┘
           │ dispatches to
           ▼
┌──────────────────────┐
│   SectionRegistry    │
│  Map<name, Section>  │
└──────────┬───────────┘
           │ each section implements
           ▼
┌──────────────────────────────────────┐
│         ConfigureSection             │
│  ─────────────────────────────────   │
│  name: string                        │
│  label: string                       │
│  description: string                 │
│  run(ctx: WizardContext): Promise<>  │
│  validate?(ctx): Promise<Diagnostic>│
└──────────────────────────────────────┘
           │ sections mutate
           ▼
┌──────────────────────────────────────┐
│         WizardContext                │
│  ─────────────────────────────────   │
│  config: MoziConfig (mutable draft) │
│  configPath: string                 │
│  secrets: SecretManager              │
│  ui: WizardUI                        │
│  persist(): Promise<void>            │
└──────────────────────────────────────┘
```

### 1. ConfigureSection Interface

```typescript
interface ConfigureSection {
  /** Unique section identifier */
  name: string;
  /** Display label for menu */
  label: string;
  /** One-line description */
  description: string;
  /** Controls menu ordering — lower numbers appear first */
  order: number;
  /** Run the section's interactive flow */
  run(ctx: WizardContext): Promise<SectionResult>;
  /** Optional: validate current config for this section */
  validate?(ctx: WizardContext): Promise<Diagnostic[]>;
}

type SectionResult = {
  /** Whether config was modified */
  modified: boolean;
  /** Optional message to display */
  message?: string;
};

type Diagnostic = {
  level: 'error' | 'warning' | 'info';
  message: string;
};
```

### 2. SectionRegistry

```typescript
class SectionRegistry {
  private sections = new Map<string, ConfigureSection>();

  register(section: ConfigureSection): void;
  get(name: string): ConfigureSection | undefined;
  /** Returns sections sorted by `order` */
  list(): ConfigureSection[];
  names(): string[];
}
```

Sections self-register at import time. The registry is populated in a
single `registerAllSections()` call that imports each section module.

### 3. WizardContext

The shared context object passed to every section:

```typescript
interface WizardContext {
  /** Mutable config draft — sections modify this directly */
  config: MoziConfig;
  /** Path to the config file being edited */
  configPath: string;
  /** Secret manager for API keys and credentials */
  secrets: SecretManager;
  /** UI primitives for interactive prompts */
  ui: WizardUI;
  /** Persist current config state to disk */
  persist(): Promise<void>;
  /** Whether running in non-interactive mode */
  nonInteractive: boolean;
}
```

### 4. WizardUI

Abstracted prompt layer (wraps `@clack/prompts` or similar):

```typescript
/** Thrown when user cancels a prompt (Ctrl+C / Escape) */
class WizardCancelledError extends Error {
  constructor() { super('User cancelled'); }
}

interface WizardUI {
  intro(message: string): void;
  outro(message: string): void;
  /** All prompt methods throw WizardCancelledError on cancel */
  text(opts: { message: string; placeholder?: string; validate?: (v: string) => string | void }): Promise<string>;
  confirm(opts: { message: string; initialValue?: boolean }): Promise<boolean>;
  select<T>(opts: { message: string; options: { value: T; label: string; hint?: string }[] }): Promise<T>;
  multiselect<T>(opts: { message: string; options: { value: T; label: string; hint?: string }[]; required?: boolean }): Promise<T[]>;
  password(opts: { message: string; validate?: (v: string) => string | void }): Promise<string>;
  spinner(): { start(msg: string): void; stop(msg?: string): void };
  note(message: string, title?: string): void;
  warn(message: string): void;
  error(message: string): void;
}
```

**Cancellation contract**: All interactive prompt methods (`text`, `confirm`, `select`,
`multiselect`, `password`) throw `WizardCancelledError` when the user presses Ctrl+C
or Escape. Sections should let this propagate; the orchestrator catches it and offers
to save partial progress.

### 5. SecretManager

Unified secret access — resolves the current dual-storage problem.

**Scope model** aligns with existing `auth-secrets.ts` which uses `global | agent`
with a `scopeId` and cascading resolution (`getEffective`):

```typescript
type SecretScope = {
  type: 'global';
} | {
  type: 'agent';
  agentId: string;
};

interface SecretManager {
  /** Get a secret by key in a specific scope */
  get(key: string, scope?: SecretScope): Promise<string | undefined>;
  /** Get with cascading fallback: agent scope → global scope */
  getEffective(key: string, agentId?: string): Promise<string | undefined>;
  /** Set a secret */
  set(key: string, value: string, scope?: SecretScope): Promise<void>;
  /** Delete a secret */
  delete(key: string, scope?: SecretScope): Promise<void>;
  /** List all secret keys in scope */
  list(scope?: SecretScope): Promise<string[]>;
  /** Check if a secret exists */
  has(key: string, scope?: SecretScope): Promise<boolean>;
}
```

**Backend strategy**:
- Default backend: `.env` file (`~/.mozi/.env`) — write path for the wizard
- Read-only bridge: SQLite `auth-secrets` store — so existing secrets are visible
- Future: migrate to SQLite as primary if needed

**Placement**: `src/storage/secrets/` (cross-cutting concern, not wizard-specific).

**Relationship with `mozi auth`**: The existing `mozi auth set/list/remove` commands
will be refactored to use `SecretManager` as their backend. This consolidation is
planned for Milestone 2 to avoid scope creep in M1.

### 6. Wizard Orchestrator

```typescript
async function runConfigureWizard(opts: {
  sections?: string[];       // run specific sections (batch mode)
  configPath?: string;       // override config path
  nonInteractive?: boolean;  // skip prompts, use defaults/env
}): Promise<void> {
  const registry = createSectionRegistry();
  const ctx = await createWizardContext(opts);

  try {
    if (opts.sections?.length) {
      // Batch mode: run specified sections in order
      for (const name of opts.sections) {
        const section = registry.get(name);
        if (!section) throw new Error(`Unknown section: ${name}`);
        const result = await section.run(ctx);
        if (result.modified) await ctx.persist();
      }
    } else {
      // Interactive mode: show menu, loop until done
      while (true) {
        const choice = await ctx.ui.select({
          message: 'What would you like to configure?',
          options: [
            ...registry.list().map(s => ({
              value: s.name,
              label: s.label,
              hint: s.description,
            })),
            { value: '__done', label: 'Done', hint: 'Save and exit' },
          ],
        });
        if (choice === '__done') break;
        const section = registry.get(choice as string)!;
        const result = await section.run(ctx);
        // Persist after each section to avoid data loss on crash/cancel
        if (result.modified) await ctx.persist();
      }
    }
    ctx.ui.outro('Configuration saved.');
  } catch (err) {
    if (err instanceof WizardCancelledError) {
      // Offer to save partial progress (already persisted per-section)
      ctx.ui.warn('Configuration cancelled. Any completed sections were already saved.');
    } else {
      throw err;
    }
  }
}
```

### 7. CLI Integration

```
mozi configure                    # interactive wizard (all sections)
mozi configure --section model    # run specific section
mozi configure --section provider --section secrets  # batch
mozi configure --non-interactive  # use env vars / defaults
```

Registered as a top-level Commander command in `src/cli/index.ts`.

---

## Milestone 1: Provider + Model + Secrets

### Section: `provider`

Guides the user through:
1. Select provider type (openai, anthropic, google, openrouter, ollama, etc.)
2. Enter API key (via `secrets.set()`) or select existing credential
3. Configure provider-specific options (base URL, headers, org ID)
4. Write provider entry to `config.models.providers`

Uses a provider flow registry (inspired by openclaw's `SIMPLE_API_KEY_PROVIDER_FLOWS`):

```typescript
interface ProviderFlow {
  id: string;                      // e.g. 'openai'
  label: string;                   // e.g. 'OpenAI'
  apiEnvVar: string;               // e.g. 'OPENAI_API_KEY'
  defaultBaseUrl?: string;
  /** Auth method — matches ModelProviderSchema.auth */
  auth?: 'api-key' | 'aws-sdk' | 'oauth' | 'token';
  /** Custom auth header name (default: Authorization) */
  authHeader?: string;
  /** Default headers to include in requests */
  defaultHeaders?: Record<string, string>;
  validateKey?(key: string): Promise<boolean>;
  /** For complex providers (e.g. anthropic token flow, OAuth) */
  customFlow?(ctx: WizardContext): Promise<ProviderConfig | null>;
}
```

Simple providers only need a registry entry. Complex ones provide `customFlow`.

**Single source of truth for env vars**: The `apiEnvVar` field in `ProviderFlow`
entries is the canonical source. The runtime `ProviderRegistry.ENV_MAP` (currently
hardcoded in `src/runtime/provider-registry.ts`) must be replaced with a shared
constant derived from the `ProviderFlow` registry. This is addressed in Task 02.

### Section: `model`

Guides the user through:
1. List configured providers
2. Select provider → show available models
3. Pick or enter model name
4. Set as default model (or assign to specific agent/role)
5. Write to `config.models.definitions` and/or `config.models.aliases`

### Section: `secrets`

Manages API keys and credentials:
1. List current secrets (masked)
2. Add / update / delete secrets
3. Validate secrets against their provider endpoints
4. Show which config fields reference which secrets

---

## File Structure

```
src/
  storage/
    secrets/
      types.ts                  # SecretManager interface, SecretScope
      manager.ts                # SecretManager composite implementation
      env-backend.ts            # .env file backend (read/write)
      sqlite-backend.ts         # SQLite backend bridge (read-only in M1)
  configure/
    index.ts                    # exports runConfigureWizard
    types.ts                    # ConfigureSection, WizardContext, SectionResult, etc.
    registry.ts                 # SectionRegistry + registerAllSections
    context.ts                  # createWizardContext
    ui.ts                       # WizardUI + WizardCancelledError
    sections/
      provider.ts               # Provider section
      model.ts                  # Model section
      secrets.ts                # Secrets section
    provider-flows/
      index.ts                  # ProviderFlow registry + shared ENV constants
      openai.ts
      anthropic.ts
      google.ts
      openrouter.ts
      ollama.ts
  cli/
    commands/
      configure.ts              # Commander command wiring
```

---

## Design Decisions

### Why not copy openclaw's approach directly?

1. **Section dispatch**: openclaw uses if/else chains — we use a registry with
   typed section objects. This means adding a section = add a file + register it.

2. **Secret management**: openclaw has separate secrets configure + env files +
   auth profiles. We unify behind `SecretManager` interface with pluggable backends.

3. **UI layer**: openclaw mixes prompt calls directly into wizard logic. We abstract
   via `WizardUI` so we can swap prompt libraries or support non-interactive mode cleanly.

### Why WizardContext instead of passing individual args?

Single context object means:
- Sections don't need to know about config file paths, persistence, etc.
- Adding new shared capabilities doesn't change section signatures
- Testing is easy: mock one object

### Why ProviderFlow registry?

Most providers follow the same pattern: name + API key + optional base URL.
A declarative registry handles 80% of cases. The `customFlow` escape hatch
handles complex providers (Anthropic token flow, OAuth, etc.) without
polluting the common path.

### Non-interactive mode contract

When `ctx.nonInteractive` is `true`, sections must:
1. Read required values from environment variables (e.g. `OPENAI_API_KEY`)
2. Use sensible defaults for optional values
3. Throw a descriptive error if a required value is missing (not prompt for it)
4. Skip confirmation prompts — assume `true`

This enables CI/CD and scripted setup scenarios. Each section documents which
env vars it reads in non-interactive mode.

---

## Resolved Questions

1. **Keep `mozi config` and `mozi configure` separate?**
   → **Yes**. `config` is for power users (direct key manipulation),
   `configure` is the guided experience. They coexist.

2. **SecretManager backend strategy?**
   → `.env` as default write backend. SQLite `auth-secrets` as read-only bridge
   from day one (so existing secrets are visible). Full SQLite migration deferred.

3. **Provider key validation — mandatory or optional?**
   → **Optional**. Offer to validate, don't block on network issues.

4. **Relationship between `mozi auth` and `secrets` section?**
   → In M1, they coexist independently. In M2, `mozi auth` will be refactored
   to use `SecretManager` as its backend, consolidating the two paths.
