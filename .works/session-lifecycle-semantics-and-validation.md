# Session Lifecycle Semantics & Validation Cases

Status: Draft agreed in design discussion (user + assistant)
Scope: Semantic contract only (no implementation details)

## 0) Terminology (finalized)

- **Session (identity anchor)**: conversation continuity identity under a routing bucket.
- **Context (working set)**: what is actually fed to the model for one turn.
- **Memory (durable recall)**: persistent, cross-turn/cross-session retrievable knowledge.

---

## 1) `/new` semantics (finalized)

`/new` **MUST** create a new conversation segment (`new sessionId`) under the same routing bucket (`sessionKey`), move the previous segment to immutable history, and repoint `latest` to the new segment.

`/new` **MUST NOT** merely clear context in-place.

---

## 2) Auto-rollover trigger matrix (finalized)

A new conversation segment:

- **MUST** be created on hard trigger (`/new`).
- **SHOULD** be created on temporal freshness expiry (default: 12h active window OR day-boundary rollover).
- **MAY** be created on semantic topic-shift when control-plane classifier confidence exceeds threshold.

Semantic trigger decisions **MUST** be debounced and reversible.

---

## 3) Control-plane model configuration (finalized)

Lifecycle decision model:

- **MUST** be explicitly configurable at `agents.defaults`.
- **MAY** be overridden per session.
- **MUST** follow deterministic fallback chain when unset.
- **MUST NOT** implicitly depend on active reply-generation model.

---

## 4) `latest` pointer and history consistency (finalized)

For each routing bucket (`sessionKey`):

- There is exactly one mutable `latest` segment pointer.
- Prior segments are append-only, immutable history.
- Default context assembly reads from `latest` only.
- History recall requires explicit retrieval rationale and must not be auto-injected by default.

---

## 5) Legacy compatibility statement (finalized)

Current Mozi behavior is single-slot continuity per `sessionKey`, where `/new` clears in-place context and does not rotate segment id.

Once segmented lifecycle semantics are adopted, that behavior should be treated as legacy compatibility mode.

---

## 6) Validation cases (for future tests)

Format: Given / When / Then

### A. `/new` behavior

**A1 Hard cut creates new segment**
- Given: `sessionKey=K`, `latest=S1`, S1 has messages
- When: user sends `/new`
- Then: create `S2`, set `latest=S2`, archive `S1` immutable

**A2 Repeated `/new` preserves chain**
- Given: `K` currently at `S1`
- When: `/new` twice
- Then: history chain `S1 -> S2 -> S3`, `latest=S3`

### B. Trigger matrix

**B1 Hard trigger always rolls**
- Given: any state
- When: `/new`
- Then: segment rotation occurs unconditionally

**B2 Temporal expiry rolls**
- Given: last activity beyond policy window (>12h or day rollover)
- When: next inbound message arrives
- Then: auto-rotate to new segment

**B3 Temporal within-window does not roll**
- Given: activity within freshness window
- When: next inbound message arrives
- Then: remain on current `latest`

**B4 Semantic high-confidence may roll**
- Given: classifier confidence > threshold
- When: inbound indicates topic shift
- Then: rotation may occur (subject to debounce)

### C. Control-plane model precedence

**C1 Defaults model used when session override absent**
- Given: `agents.defaults.controlModel=A`, no session override
- When: lifecycle decision executes
- Then: model `A` is used

**C2 Session override wins**
- Given: defaults `A`, session override `B`
- When: lifecycle decision executes
- Then: model `B` is used

**C3 Deterministic fallback when unset**
- Given: no defaults/session model configured
- When: lifecycle decision executes
- Then: deterministic fallback chain is used, reproducible outcome

**C4 Reply model switch does not change control model implicitly**
- Given: reply model changes X -> Y
- When: lifecycle decision executes
- Then: control model remains unchanged unless config says otherwise

### D. `latest`/history consistency

**D1 Default assembly reads latest only**
- Given: history `S1,S2`, latest `S3`
- When: build turn context
- Then: source is `S3` only (no implicit `S1/S2` injection)

**D2 Explicit recall can pull history**
- Given: explicit recall request matches `S1`
- When: retrieval runs
- Then: `S1` fragments may be injected with rationale metadata

**D3 Archived segment is immutable**
- Given: `S1` archived
- When: future writes happen
- Then: `S1` is not mutated in place

### E. Debounce/reversal safety

**E1 Debounce prevents thrashing**
- Given: repeated high-confidence semantic triggers in cooldown window
- When: multiple inbound messages arrive quickly
- Then: at most one rotation in cooldown interval

**E2 Reversal for semantic misfire**
- Given: semantic-trigger rotation to `S2`, later evidence indicates false split
- When: reversal rule executes
- Then: restore/merge policy preserves continuity and no message loss

### F. Legacy mode parity tests

**F1 Legacy mode `/new` clears in place**
- Given: legacy compatibility mode ON
- When: `/new`
- Then: context clears in-place, no segment rotation

**F2 Segmented mode forbids legacy `/new` behavior**
- Given: segmented lifecycle mode ON
- When: `/new`
- Then: must rotate to new segment; in-place clear-only behavior is invalid

---

## 7) Suggested test IDs (stable naming)

- `session_new_hard_cut_creates_segment`
- `session_new_repeated_chain_integrity`
- `session_rollover_temporal_expired`
- `session_rollover_temporal_within_window_noop`
- `session_rollover_semantic_high_confidence`
- `control_model_defaults_precedence`
- `control_model_session_override_precedence`
- `control_model_fallback_deterministic`
- `latest_context_uses_latest_only`
- `history_recall_requires_explicit_selection`
- `history_segment_immutable`
- `semantic_rollover_debounce`
- `semantic_rollover_reversible`
- `legacy_mode_new_inplace_clear`
- `segmented_mode_new_must_rotate`
