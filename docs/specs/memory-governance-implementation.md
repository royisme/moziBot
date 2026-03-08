# Memory Governance Implementation Spec

## Purpose

This document defines an executable implementation plan for Mozi's memory governance pipeline.

The main problem to solve is **not retrieval quality**. Mozi already has a capable retrieval stack (`builtin`, `qmd`, `embedded`, hybrid recall, MMR, temporal decay). The main problem is that **memory writes are not governed**: current write paths can persist low-value or transcript-like content directly into durable memory files.

The goal of this spec is to introduce a programmatic write pipeline where:

- prompt only influences extraction tendency
- code enforces write boundaries
- agents do not write durable memory files directly
- daily memory and long-term memory are separated by policy
- long-term memory is rebuilt from structured promoted facts, not append-based logging

## Goals

1. Route all memory writes through a single governed pipeline.
2. Introduce a structured `MemoryCandidate` contract.
3. Separate short-term daily memory from long-term stable memory.
4. Prevent raw transcript leakage into durable memory.
5. Add promotion gating before any change to `MEMORY.md`.
6. Make memory maintenance deterministic, auditable, and idempotent.
7. Integrate with existing Mozi components instead of replacing the retrieval stack.

## Non-Goals

1. Do not replace existing retrieval backends:
   - `BuiltinMemoryManager`
   - `EmbeddedMemoryManager`
   - `QmdMemoryManager`
   - `FallbackMemoryManager`
2. Do not redesign `recall.ts`, MMR, or temporal decay logic.
3. Do not convert canonical memory storage away from Markdown in this phase.
4. Do not build a separate memory microservice.
5. Do not try to solve learned personalization or RL-style ranking in this phase.

## Current State Summary

Current write-side behavior is split across multiple paths:

- `src/runtime/hooks/bundled/memory-maintainer.ts`
  - accumulates turn lines
  - writes to `MEMORY.md`
  - writes to dated daily files
- `src/memory/flush-manager.ts`
  - writes transcript-like session flush blocks
- `src/runtime/host/message-handler/services/memory-flush.ts`
  - orchestrates flush and lifecycle notification
- `src/runtime/context-management/compaction.ts`
  - compacts live context, but is not durable memory governance

Current problems:

- no candidate/inbox stage
- no write validator
- no promotion threshold
- `MEMORY.md` can be directly polluted by low-quality writes
- context continuity artifacts and durable memory share storage patterns
- dual write paths are not coordinated by one policy engine

## Target Architecture

### Core Principle

`conversation -> extraction -> candidate inbox -> policy engine -> daily compiler -> promotion gate -> MEMORY.md rebuild`

### Storage Layers

#### 1. Inbox (structured, append-only, machine-oriented)

Path:

- `memory/inbox/YYYY-MM-DD.jsonl`

Purpose:

- durable capture of structured candidate events
- replay/debug source for compilers and maintenance jobs
- crash-safe staging layer

Properties:

- append-only
- idempotent event writes by candidate ID
- not directly consumed by end users
- may contain rejected and accepted candidates, but with status recorded

#### 2. Daily memory (human-readable, short-term)

Path:

- `memory/daily/YYYY-MM-DD.md`

Purpose:

- concise short-term memory for current/recent work
- acceptable retrieval source with temporal decay
- records decisions, lessons, blockers, active work, and todos

Properties:

- generated from accepted daily candidates
- section-based rewrite, not arbitrary append
- transcript-like content forbidden

#### 3. Long-term memory (human-readable, stable)

Path:

- `MEMORY.md`

Purpose:

- stable user preferences, durable rules, tooling facts, long-term projects, repeated lessons

Properties:

- rebuilt from promoted facts only
- never directly appended by agent hooks
- `blocker` and `active_work` forbidden
- all entries are normalized rule-style statements

### Separation of Concerns

#### Context continuity

Session continuity and reset bridging may still exist, but they must not automatically pollute durable memory.

Acceptable outputs for context continuity:

- session snapshot files
- compacted summaries for live context

Not acceptable:

- raw transcript auto-promotion into `MEMORY.md`
- context bridge artifacts mixed into long-term memory compilation inputs

## Data Contracts

### MemoryCandidate

```ts
export type MemoryCandidateSource =
  | "turn_completed"
  | "before_reset"
  | "pre_compact"
  | "manual"
  | "maintenance";

export type MemoryCandidateCategory =
  | "decision"
  | "lesson"
  | "todo"
  | "blocker"
  | "active_work"
  | "preference"
  | "stable_rule"
  | "tooling_fact"
  | "long_term_project";

export type MemoryEvidence =
  | "user_explicit"
  | "user_confirmed"
  | "system_observed"
  | "repeated_pattern";

export type MemoryStability = "low" | "medium" | "high";

export type MemoryScopeHint = "daily" | "long_term_candidate";

export interface MemoryCandidate {
  id: string;
  ts: string;
  agentId: string;
  sessionId?: string;
  source: MemoryCandidateSource;
  category: MemoryCandidateCategory;
  summary: string;
  details?: string;
  evidence: MemoryEvidence[];
  confidence: number;
  stability: MemoryStability;
  scopeHint: MemoryScopeHint;
  dedupeKey: string;
  promoteCandidate: boolean;
  status?: "pending" | "accepted_daily" | "rejected" | "promoted" | "invalidated";
  rejectionReason?: string;
}
```

### Candidate Status Rules

- `pending`: written to inbox, not processed yet
- `accepted_daily`: passed daily policy and included in daily compile
- `rejected`: blocked by validator or dedupe policy
- `promoted`: accepted into long-term fact store and reflected in `MEMORY.md`
- `invalidated`: previously promoted fact is no longer valid

### Dedupe Key Strategy

Two levels:

#### Level 1: deterministic fast dedupe

Generated from normalized fields:

- category
- normalized summary
- normalized target scope
- agentId

Normalization rules:

- lowercase
- collapse whitespace
- strip obvious discourse prefixes (`user said`, `assistant noted`, etc.)
- strip dates/timestamps if not semantically necessary
- strip volatile numeric fragments where safe

#### Level 2: semantic dedupe (later phase)

Optional v1.5/v2 enhancement:

- similarity comparison over promoted facts
- merge near-duplicates with same semantic meaning but different wording

## Category Mapping Rules

### Daily-only categories

These can appear in inbox and daily memory, but never in `MEMORY.md`:

- `todo`
- `blocker`
- `active_work`

### Daily + promotable categories

These first land in daily memory and may later promote if stabilized:

- `decision`
- `lesson`

### Long-term-candidate-first categories

These may enter promote queue immediately if policy allows:

- `preference`
- `stable_rule`
- `tooling_fact`
- `long_term_project`

## Long-term Section Mapping

`MEMORY.md` must be generated from structured sections only:

- `## User Preferences`
  - from promoted `preference`
- `## Stable Rules`
  - from promoted `stable_rule`
  - from promoted `decision` rewritten as stable guidance when appropriate
- `## Tooling Facts`
  - from promoted `tooling_fact`
- `## Long-term Projects`
  - from promoted `long_term_project`
- `## Repeated Lessons`
  - from promoted `lesson` when repeated/stable

Rules:

- `blocker` and `active_work` never appear here
- `todo` never appears here
- entries must be rule-like or fact-like, not transcript-like
- section output is rebuilt from structured state on every write

## Policy Engine

### Hard Rejections

Reject any candidate from durable write paths when any of the following is true:

1. Contains transcript markers like repeated `User:` / `Assistant:` formatting
2. Is primarily a raw conversation excerpt rather than a summary
3. Is only a URL or a link dump
4. Is dominated by emotional filler / repeated urgency / non-instructional tone
5. Contains temporary runtime state with no expected future reuse
6. Contains single-task ephemeral execution detail unsuitable for recall
7. Attempts long-term write for forbidden categories:
   - `todo`
   - `blocker`
   - `active_work`

### Daily Acceptance Rules

Allow into daily memory if:

- summary is concise and non-transcript-like
- category is one of:
  - `decision`
  - `lesson`
  - `todo`
  - `blocker`
  - `active_work`
  - optionally `preference` / `tooling_fact` when also useful short-term
- confidence exceeds configurable minimum

### Promotion Rules

A candidate is eligible for promote queue if at least one is true:

- evidence includes `user_explicit`
- category in:
  - `preference`
  - `stable_rule`
  - `tooling_fact`
  - `long_term_project`
- same dedupe family appears repeatedly within a configurable time window
- stability is `high` and confidence exceeds threshold

### Example Scoring Model

```ts
score = 0
if evidence.includes("user_explicit") score += 5
if category === "preference" score += 4
if category === "stable_rule" score += 4
if category === "tooling_fact" score += 3
if evidence.includes("repeated_pattern") score += 4
if stability === "high" score += 2
if category === "long_term_project" score += 2
if category === "decision" score += 1
if category === "lesson" score += 1
if category === "todo" score -= 5
if category === "blocker" score -= 5
if category === "active_work" score -= 5
if transcriptLike score -= 10
if ephemeralState score -= 6
```

Promotion threshold should be configurable.

## Functional Components

### 1. MemoryExtractionService

Responsibilities:

- receive turn/reset/pre-compact events
- extract structured `MemoryCandidate[]`
- assign categories and evidence markers
- generate `dedupeKey`
- write candidates into inbox

Integration:

- replaces direct final-file writing behavior in `memory-maintainer`
- may be invoked from `FlushManager` integration points

### 2. MemoryInboxStore

Responsibilities:

- append candidates to `memory/inbox/YYYY-MM-DD.jsonl`
- maintain idempotent writes by candidate ID
- support scans by date range / status
- support marking processed statuses

Implementation note:

- JSONL file-based store is sufficient for v1
- no need to introduce SQLite here initially unless performance demands it

### 3. MemoryPolicyEngine

Responsibilities:

- validate candidates
- classify into:
  - reject
  - daily accept
  - promote queue
- compute score and rejection reason
- apply category-to-layer constraints

### 4. DailyMemoryCompiler

Responsibilities:

- consume accepted daily candidates
- group by day
- render deterministic markdown sections
- rewrite `memory/daily/YYYY-MM-DD.md`

Suggested sections:

- `### Decisions`
- `### Active Work`
- `### Lessons`
- `### TODO`
- `### Blockers`

### 5. PromotionQueueService

Responsibilities:

- persist promotable candidates before final acceptance
- evaluate promotion score
- track recurrence across time windows
- expose candidates awaiting approval/auto-promotion

Storage options:

- `memory/promote-candidates.jsonl`
- or per-day JSONL shards

### 6. LongTermMemoryStore

Responsibilities:

- store promoted normalized facts
- track invalidated or superseded facts
- serve as source of truth for `MEMORY.md` rebuild

Implementation note:

- v1 can use JSON state + generated markdown
- markdown should not be the authoritative mutation surface

### 7. LongTermMemoryWriter

Responsibilities:

- rebuild complete `MEMORY.md`
- write only from structured promoted state
- preserve deterministic section ordering
- handle removals, updates, and replacements

### 8. MemoryMaintenanceJob

Responsibilities:

- dedupe stale candidates
- merge repeated lessons / rules
- invalidate outdated promoted facts
- prune obsolete promote candidates
- rebuild long-term memory after maintenance if changed

## Lifecycle and Scheduling

### Turn-completed path

1. turn completes
2. `MemoryExtractionService.extract()` runs
3. candidates appended to inbox
4. `MemoryPolicyEngine` evaluates
5. accepted daily candidates marked
6. optional debounce for daily compiler

### Before-reset path

1. session reset imminent
2. final extraction runs
3. pending candidates flushed to inbox
4. session continuity snapshot may still run separately
5. durable memory pipeline continues independently

### Pre-compact path

1. compaction about to occur
2. extract any high-value candidate not yet persisted
3. write only to inbox
4. do not directly update `MEMORY.md` in the hot path unless explicitly configured

### Scheduled jobs

#### Frequent job (lightweight)

Runs every few minutes or at lifecycle checkpoints:

- compile daily markdown from accepted candidates
- evaluate immediate promotion queue entries

#### Daily job (heavier)

Runs once per day:

- merge duplicates
- compute recurrence
- update promoted facts
- prune obsolete/inactive queue items
- rebuild `MEMORY.md`

## Observability and Operations

### Required logs/metrics

At minimum record:

- candidates extracted count
- accepted daily count
- rejected count by reason
- promotable count
- promoted count
- invalidated count
- compile duration
- maintenance duration

### Required debugability

Need a way to answer:

- why was this memory candidate rejected?
- why did this fact get promoted?
- which rule wrote this line into `MEMORY.md`?
- which source event created this candidate?

### Suggested artifacts

- `memory/inbox/YYYY-MM-DD.jsonl`
- `memory/promote-candidates.jsonl`
- optional `memory/ops/maintenance-log.jsonl`
- optional `memory/ops/rejections.jsonl`

## Idempotency and Failure Recovery

### Requirements

1. Re-running compiler must not duplicate daily entries.
2. Re-running promoter must not duplicate long-term facts.
3. Partial failure during `MEMORY.md` rebuild must not corrupt the file.
4. Inbox events must survive process crash.

### Strategies

- deterministic candidate IDs
- atomic write temp-file + rename for generated markdown
- processed status markers for inbox records
- rebuild from structured state rather than append mutation

## User Controls and Policy Controls

### Required controls

Config should support:

- enable/disable governed write pipeline
- extraction trigger toggles
- confidence minimums
- promotion threshold
- recurrence window
- auto-promote on explicit user memory signal
- daily compiler debounce interval
- maintenance schedule

### Explicit user intent

Support for user intent should be first-class.

Examples:

- "remember this"
- "以后按这个来"
- "不要再这样做"

This intent should not directly mutate `MEMORY.md`; it should create high-priority candidates with `user_explicit` evidence.

## Integration with Existing Mozi Code

### Keep and extend

Keep:

- retrieval managers and backend selection
- recall post-processing
- lifecycle orchestrator pattern

Refactor:

- `memory-maintainer.ts`
  - from direct writer to extraction trigger and candidate submitter
- `FlushManager`
  - separate context continuity output from durable memory extraction
- `memory-flush.ts`
  - notify pipeline without directly implying daily memory append semantics

### Recommended new modules

- `src/memory/governance/types.ts`
- `src/memory/governance/extraction-service.ts`
- `src/memory/governance/inbox-store.ts`
- `src/memory/governance/policy-engine.ts`
- `src/memory/governance/daily-compiler.ts`
- `src/memory/governance/promotion-queue.ts`
- `src/memory/governance/longterm-store.ts`
- `src/memory/governance/longterm-writer.ts`
- `src/memory/governance/maintenance-job.ts`

## Rollout Plan

### Phase 1: governed candidate path

Deliverables:

- `MemoryCandidate` type
- inbox JSONL store
- extraction service hooked into turn/reset/pre-compact
- policy engine with hard rejection rules
- no direct writes to `MEMORY.md` from hooks

Success criteria:

- candidate files produced reliably
- transcript-like content rejected before durable write
- no regression in current memory search behavior

### Phase 2: daily compiler

Deliverables:

- daily compiler
- `memory/daily/YYYY-MM-DD.md`
- section-based deterministic rendering
- accepted/rejected candidate state transitions

Success criteria:

- daily files generated from candidates only
- direct transcript append path removed from durable daily memory

### Phase 3: promotion pipeline

Deliverables:

- promotion queue
- scoring
- long-term fact store
- `MEMORY.md` rebuild writer

Success criteria:

- `MEMORY.md` only rebuilt from promoted facts
- forbidden categories absent from long-term memory
- explicit user memory instructions surface as promotable candidates

### Phase 4: maintenance and cleanup

Deliverables:

- stale prune
- recurrence merge
- invalidation flow
- maintenance logs and metrics

Success criteria:

- memory quality stable over time
- outdated facts removable without manual file surgery

## Testing Strategy

### Unit tests

Need tests for:

- candidate normalization
- dedupe key generation
- category mapping
- validator rejection cases
- promotion scoring
- daily markdown rendering
- long-term markdown rendering
- invalidation and rebuild behavior

### Integration tests

Need tests for:

- turn_completed -> inbox write
- before_reset -> inbox write
- pre_compact -> inbox write
- daily compiler output
- promotion queue -> `MEMORY.md` rebuild
- failure recovery after interrupted write

### Regression tests

Need to ensure:

- existing retrieval backends still read generated markdown correctly
- lifecycle orchestrator still syncs memory index correctly
- `memorySearch` results remain stable or improve

## Open Decisions to Resolve During Implementation

1. Whether extraction is initially rule-based, LLM-based, or hybrid
2. Whether promote queue requires human review mode in v1
3. Whether existing `MEMORY.md` should be migrated or governance should apply only forward
4. Whether daily compiler should rewrite only touched days or support full rebuild
5. Whether long-term fact store should be JSONL or JSON object state in v1

## Final Design Rule

Prompt expresses intent. Code enforces boundaries.

Specifically:

- prompts may help identify memory-worthy content
- code decides whether the candidate is valid
- code decides which layer the memory can enter
- code decides when and how durable files are rebuilt
- durable memory quality must not depend on agent self-restraint
