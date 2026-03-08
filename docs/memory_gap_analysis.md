# Memory Gap Analysis: OpenClaw vs Mozi

**Purpose**: Decision-oriented comparison to guide the next design pass on Mozi's memory governance pipeline. The goal is not to audit retrieval quality — both systems retrieve adequately — but to identify why write quality degrades over time and what engineering controls are missing.

---

## 1. What Mozi Already Has

**Retrieval (mature)**

- Three pluggable backends: `BuiltinMemoryManager` (file + SQLite), `EmbeddedMemoryManager` (local vector), `QmdMemoryManager` (external service)
- `FallbackMemoryManager` wraps primary with automatic circuit-breaker fallback
- `MemoryLifecycleOrchestrator` handles sync triggering on session-start, flush, and search events
- `recall.ts`: post-retrieval pipeline with temporal decay (half-life scoring), MMR diversification, and sampled metrics logging
- `memorySearch` / `memoryGet` agent tools with session-scoped search

**Write infrastructure (partial)**

- `memory-maintainer.ts`: hook-driven, fires on `turn_completed` and `before_reset`; debounced flush with turn-count gating; secret-pattern filtering; appends deduplicated lines to `MEMORY.md` and dated archive files
- `FlushManager`: appends raw message transcript slices to daily `.md` files
- `flushMemoryWithLifecycle` (in `memory-flush.ts`): orchestrates flush + lifecycle notification with timeout guard
- `writeSessionMemorySnapshot`: LLM-slug-named session snapshot files written on reset

---

## 2. What OpenClaw Demonstrates

OpenClaw's memory concepts worth borrowing (based on migration blueprint and prior analysis):

- **Governed write pipeline**: memory candidates are extracted as structured objects before any file write occurs; write is a separate, policy-controlled step
- **Candidate schema**: each memory item carries `scope`, `category`, `confidence`, `tags`, and a `promoteCandidate` flag; this makes policy evaluation deterministic
- **Inbox / staging layer**: candidates enter a staging buffer (JSONL or in-memory queue) before promotion; agent cannot write directly to durable files
- **Validator / ranker**: hard rules reject raw transcript, single-task state, and bare URLs; a scoring function gates promotion to long-term memory
- **Promotion gate**: long-term memory (`MEMORY.md` equivalent) only accepts items above a score threshold or with explicit user intent signals
- **Maintenance jobs**: periodic dedupe, merge, compact, and prune runs keep durable memory clean over time

OpenClaw does not have significantly better retrieval than Mozi; its advantage is entirely on the write side.

---

## 3. Shared Gaps

Both systems lack:

1. **Structured candidate representation** — writes go from conversation turn directly to file, skipping any intermediate structured object
2. **Policy validation layer** — no programmatic rules reject low-value content before it is persisted
3. **Separation of daily memory vs long-term memory write paths** — both layers are written by the same append-based code with no different quality gates
4. **Maintenance jobs** — no scheduled dedupe, merge, or prune; memory only grows

---

## 4. Mozi-Specific Gaps

Beyond shared gaps, Mozi has the following additional problems:

- **`FlushManager` writes raw transcript slices** — `buildMarkdownEntry` appends `User:` / `Assistant:` content verbatim up to `maxChars`; this is transcript leakage into durable memory, not summarized facts
- **`memory-maintainer` buffers turn lines without category** — lines are `User: <text>` / `Assistant: <text>` strings; there is no `scope`, `category`, or quality signal attached
- **Dual write paths are not coordinated** — `memory-maintainer` and `FlushManager` both write to the same `memory/` directory via different triggers; there is no unified write policy
- **Agent tools have no write capability** — `memorySearch` and `memoryGet` exist; there is no `memoryWrite` tool, so agents cannot explicitly submit structured memory candidates; writes only happen through side-channel hooks
- **No promotion gate to `MEMORY.md`** — `writeMemoryArtifacts` in `memory-maintainer` appends to `MEMORY.md` whenever fresh lines pass dedup; there is no confidence threshold or category check
- **Context compaction is conflated with durable memory management** — `writeSessionMemorySnapshot` (session snapshot on reset) and `FlushManager` (raw transcript append) serve context continuity across session resets, not long-term memory governance; these two concerns are currently served by the same code path with no explicit distinction

---

## 5. Distinguishing Context Compaction from Durable Memory

These are two different problems that should not share implementation:

| Concern | Purpose | Retention | Quality bar |
|---|---|---|---|
| **Context compaction** | Preserve session continuity across resets; bridge the context window gap | Session-scoped; can be discarded after a few days | Low — summarized transcript is acceptable |
| **Durable memory management** | Accumulate stable, reusable facts, preferences, rules, and lessons | Long-lived; grows the agent's permanent knowledge | High — only promoted, validated content |

Currently Mozi conflates them: `FlushManager` and `writeSessionMemorySnapshot` serve compaction, but their output lands in the same directory read by retrieval backends, polluting long-term recall with ephemeral session content.

---

## 6. Recommended Implementation Order for Mozi

Implement in this sequence. Each stage is a prerequisite for the next.

**Stage 1 — Write policy definition**
Define the two write destinations explicitly: `daily/` (compaction + short-term events) and `MEMORY.md` (long-term promoted facts). Document what may and may not enter each layer. No code change yet; this is a schema/policy document.

**Stage 2 — Candidate schema**
Introduce a `MemoryCandidate` type with at minimum: `scope` (`daily` | `longterm`), `category` (e.g. `decision`, `lesson`, `active_work`, `user_preference`, `stable_rule`), `summary` (string), `confidence` (number 0–1), `source` (`turn` | `explicit` | `maintenance`).

**Stage 3 — Inbox / staging buffer**
Route all memory writes through a staging buffer (JSONL file or in-memory queue per session). Neither `memory-maintainer` nor `FlushManager` should write directly to `MEMORY.md`. The buffer is the single write entry point.

**Stage 4 — Validators**
Implement a daily validator (rejects raw transcript, bare URLs, emotional filler) and a long-term validator (rejects `active_work`, single-task state, raw message content). Validators run against staged candidates before any file write.

**Stage 5 — Promotion gate**
Implement a scorer that evaluates candidates against promotion rules (e.g. explicit user intent +5, repeated lesson +4, single-task state -4, raw transcript -10). Only candidates exceeding a threshold are written to `MEMORY.md`.

**Stage 6 — Maintenance jobs**
Add a scheduled job (triggered by `MemoryLifecycleOrchestrator` or a cron-style hook) that runs dedupe, merge, compact, and prune against `MEMORY.md` and daily files. This is what keeps memory quality stable over time.

---

## 7. Non-Goals / Things Not to Rebuild

- Do not replace the retrieval backends — `BuiltinMemoryManager`, `EmbeddedMemoryManager`, `QmdMemoryManager`, and `FallbackMemoryManager` are adequate
- Do not redesign `recall.ts` — temporal decay and MMR are working and well-tested
- Do not rebuild `MemoryLifecycleOrchestrator` — it is a good sync-trigger abstraction; extend it to fire maintenance jobs rather than replacing it
- Do not redesign session snapshot naming or slug generation — these serve compaction and are fine as-is once compaction is separated from durable memory
- Do not introduce a separate memory service process — all of this can be implemented within the existing hook and manager architecture

---

## 8. Open Questions for Next Design Pass

1. **Where does the inbox live?** In-memory per-session buffer vs. a JSONL file per agent — what are the tradeoffs for durability across crashes?

2. **Who extracts candidates?** Should extraction be LLM-based (structured extraction prompt per turn) or rule-based (pattern matching on turn content)? LLM extraction is higher quality but adds latency and cost on every turn.

3. **How is explicit user intent signaled?** Does "remember this" go through the `memoryWrite` agent tool, or is it detected heuristically in the hook? A tool gives cleaner semantics; heuristics are fragile.

4. **How are daily files and long-term `MEMORY.md` kept separate in retrieval?** Currently both are in the same directory and indexed together. Should the retrieval backends treat them as different scopes with different decay parameters?

5. **What triggers promotion?** On every flush, at session end, or on a maintenance job schedule? Promotion on every flush risks premature long-term writes; infrequent promotion risks stale staging buffers.

6. **How do we migrate existing `MEMORY.md` content?** Existing files contain mixed transcript and fact content. Should a one-time migration job reclassify and prune them, or do we accept the current state and only govern forward?

7. **What is the interface contract between `memory-maintainer` and the new pipeline?** Should `memory-maintainer` be refactored in place or replaced by a new `MemoryExtractionService` that calls into the staged pipeline?
