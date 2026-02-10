# Session Lifecycle Development Plan (No Legacy Compatibility)

Status: Active development plan
Scope: Implement segmented lifecycle semantics directly (no legacy mode path)
Source of truth: `.works/session-lifecycle-semantics-and-validation.md`

## Goal

Implement runtime-native segmented session lifecycle where:

- `sessionKey` = routing bucket identity
- `sessionId` = current segment identity
- `/new` always rotates to a new segment
- default context uses `latest` segment only
- history is immutable and recall-only

---

## Phase 1 — Data Model & Config Foundation

### Deliverables

1. Extend session persistence model from single-slot to segmented ledger index.
2. Add lifecycle config for temporal/semantic triggers and control-plane model.
3. Keep runtime behavior unchanged except schema wiring.

### Primary files

- `src/runtime/session-store.ts`
- `src/config/schema/agents.ts`
- `src/runtime/types.ts` (and related runtime session types)

### Required outcomes

- Store can represent:
  - one `latest` pointer per `sessionKey`
  - append-only list of archived segments
  - segment metadata (createdAt, updatedAt, summary pointer, prev/next)
- Config can represent:
  - control-plane model (defaults + session override)
  - temporal trigger policy (12h/day)
  - semantic trigger threshold/debounce/reversal controls

---

## Phase 2 — `/new` Hard Cut Semantics

### Deliverables

1. Replace in-place clear behavior with mandatory segment rotation.
2. Archive prior segment and repoint `latest`.

### Primary files

- `src/runtime/host/message-handler.ts`
- `src/runtime/agent-manager.ts`
- `src/runtime/session-store.ts`

### Required outcomes

- `/new` always creates new `sessionId` under same `sessionKey`
- old segment becomes immutable history
- context for next turn starts on new segment (clean working set)

### Validation IDs

- `session_new_hard_cut_creates_segment`
- `session_new_repeated_chain_integrity`

---

## Phase 3 — Temporal Auto-Rollover

### Deliverables

1. Implement auto-segmentation on temporal freshness expiry.
2. Apply policy: 12h active window OR day-boundary rollover.

### Primary files

- `src/runtime/host/message-handler.ts`
- `src/runtime/session-store.ts`

### Required outcomes

- expired windows rotate before processing new inbound turn
- within-window activity does not rotate

### Validation IDs

- `session_rollover_temporal_expired`
- `session_rollover_temporal_within_window_noop`

---

## Phase 4 — Context Assembly Isolation (latest-only)

### Deliverables

1. Ensure default prompt assembly reads from latest segment only.
2. Prevent implicit history injection.
3. Keep archived segments immutable.

### Primary files

- `src/runtime/agent-manager.ts`
- `src/runtime/session-store.ts`
- `src/runtime/context-management/*` (if needed for assembly boundary)

### Required outcomes

- context assembly scope is latest segment by default
- history only enters context via explicit recall path with rationale

### Validation IDs

- `latest_context_uses_latest_only`
- `history_recall_requires_explicit_selection`
- `history_segment_immutable`

---

## Phase 5 — Control-Plane Model Precedence

### Deliverables

1. Implement dedicated lifecycle decision model resolution.
2. Decouple lifecycle control model from reply generation model.

### Primary files

- `src/runtime/agent-manager.ts` (or dedicated lifecycle resolver)
- `src/config/schema/agents.ts`
- lifecycle evaluation module (new file under `src/runtime/host` or `src/runtime/context-management`)

### Required outcomes

- precedence: session override > defaults > deterministic fallback
- no implicit coupling to active reply model

### Validation IDs

- `control_model_defaults_precedence`
- `control_model_session_override_precedence`
- `control_model_fallback_deterministic`

---

## Phase 6 — Semantic Trigger + Debounce/Reversal

### Deliverables

1. Add semantic topic-shift classifier hook via control-plane model.
2. Add debounce guardrails.
3. Add reversible misfire handling.

### Primary files

- lifecycle trigger evaluator module
- `src/runtime/host/message-handler.ts`
- `src/runtime/session-store.ts` (decision metadata)

### Required outcomes

- high-confidence semantic shifts can rotate segment
- repeated short-window triggers do not thrash
- misfire can be reversed without message loss

### Validation IDs

- `session_rollover_semantic_high_confidence`
- `semantic_rollover_debounce`
- `semantic_rollover_reversible`

---

## Test Mapping (Must pass before completion)

From semantics doc section 7:

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

Note: legacy-specific IDs intentionally excluded from this plan.

---

## Execution Order (Strict)

1. Phase 1
2. Phase 2
3. Phase 3
4. Phase 4
5. Phase 5
6. Phase 6

No parallel feature merges that cross phase boundaries.

---

## Done Criteria

- All phases completed
- All listed validation IDs green
- `/new` is hard-cut rotation by default
- Temporal and semantic rollover active under configured policies
- latest-only context assembly enforced
