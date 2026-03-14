# Task 01: Core Types and Section Registry

## Scope

Create the foundational types and section registry for the configure framework.

## Deliverables

### Files to create

- `src/configure/types.ts` — foundational configure interfaces and types:
  - `ConfigureSection` (with `order` field)
  - `SectionResult`
  - `Diagnostic`
  - `WizardContext`
  - `WizardUI` interface and `WizardCancelledError` type/class definitions, or a note that they live in `src/configure/ui.ts` and are re-exported from here
  - Clarify that `WizardContext.config` is a mutable draft of `MoziConfig`; sections mutate it in-place and `persist()` flushes the current draft to disk
  - Re-export `SecretManager` from `src/storage/secrets/types.ts`

- `src/storage/secrets/types.ts` — shared secret types used by both configure and runtime code:
  - `SecretScope` type (`global` | `agent` with `agentId`)
  - `SecretManager` interface stub (Task 03 implements it)
  - `SecretBackend` interface stub if needed for Task 03

- `src/configure/registry.ts` — `SectionRegistry` class:
  - `register(section)` — add section, reject duplicate names
  - `get(name)` — lookup by name
  - `list()` — return all sections sorted by `order`
  - `names()` — return sorted section names
  - `registerAllSections()` — imports and registers all section modules (initially empty, wired in later tasks)
  - Clarify that calling `registerAllSections()` when no sections exist returns an empty registry and does not throw

## Acceptance Criteria

- All types compile with `npx tsc --noEmit`
- `SectionRegistry` handles: register, get, list (sorted), duplicate rejection
- `registerAllSections()` with zero section modules returns an empty registry without error
- No runtime dependencies beyond existing project deps
- Types align with existing `MoziConfig` from `src/config/schema/index.ts`
- `ProviderFlow` is not defined here; it is introduced in Task 02 under `src/configure/provider-flows/`

## Dependencies

- None (this is the foundation)

## Blocked by

- Nothing
