/**
 * Core data contracts for the memory governance pipeline.
 *
 * All write-side memory operations flow through these types.
 * Retrieval backends remain unchanged and consume the generated markdown artifacts.
 */

// ---------------------------------------------------------------------------
// Primitive union types
// ---------------------------------------------------------------------------

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

export type CandidateStatus =
  | "pending"
  | "accepted_daily"
  | "rejected"
  | "promoted"
  | "invalidated";

// ---------------------------------------------------------------------------
// MemoryCandidate – the canonical write unit
// ---------------------------------------------------------------------------

export interface MemoryCandidate {
  /** Deterministic candidate identifier (typically hash of dedupeKey + ts). */
  id: string;
  /** ISO-8601 timestamp when the candidate was created. */
  ts: string;
  agentId: string;
  sessionId?: string;
  source: MemoryCandidateSource;
  category: MemoryCandidateCategory;
  /** Concise, rule-style or fact-style summary. Must not be transcript-like. */
  summary: string;
  details?: string;
  evidence: MemoryEvidence[];
  /** 0–1 confidence from the extraction source. */
  confidence: number;
  stability: MemoryStability;
  scopeHint: MemoryScopeHint;
  /** Normalized key used for Level-1 fast dedupe. */
  dedupeKey: string;
  /** Whether the candidate should enter the promotion queue. */
  promoteCandidate: boolean;
  status?: CandidateStatus;
  rejectionReason?: string;
}

// ---------------------------------------------------------------------------
// Category mapping constants
// ---------------------------------------------------------------------------

/** Categories that may only appear in daily memory, never in MEMORY.md. */
export const DAILY_ONLY_CATEGORIES: ReadonlySet<MemoryCandidateCategory> =
  new Set(["todo", "blocker", "active_work"]);

/** Categories that start in daily memory and may later be promoted. */
export const DAILY_AND_PROMOTABLE_CATEGORIES: ReadonlySet<MemoryCandidateCategory> =
  new Set(["decision", "lesson"]);

/** Categories eligible to enter the promotion queue immediately. */
export const LONG_TERM_CANDIDATE_CATEGORIES: ReadonlySet<MemoryCandidateCategory> =
  new Set(["preference", "stable_rule", "tooling_fact", "long_term_project"]);

/** All categories allowed to appear in daily memory output. */
export const DAILY_ALLOWED_CATEGORIES: ReadonlySet<MemoryCandidateCategory> =
  new Set([
    "decision",
    "lesson",
    "todo",
    "blocker",
    "active_work",
    "preference",
    "tooling_fact",
  ]);

/** All valid categories. */
export const ALL_CATEGORIES: ReadonlyArray<MemoryCandidateCategory> = [
  "decision",
  "lesson",
  "todo",
  "blocker",
  "active_work",
  "preference",
  "stable_rule",
  "tooling_fact",
  "long_term_project",
];

// ---------------------------------------------------------------------------
// Section mapping for MEMORY.md generation
// ---------------------------------------------------------------------------

/**
 * Maps promotable categories to their MEMORY.md section heading.
 * Categories absent from this map (daily-only) must never appear in MEMORY.md.
 */
export const LONGTERM_SECTION_MAP: Readonly<
  Partial<Record<MemoryCandidateCategory, string>>
> = {
  preference: "User Preferences",
  stable_rule: "Stable Rules",
  decision: "Stable Rules",
  tooling_fact: "Tooling Facts",
  long_term_project: "Long-term Projects",
  lesson: "Repeated Lessons",
};

// ---------------------------------------------------------------------------
// Policy verdict
// ---------------------------------------------------------------------------

export type PolicyVerdict = "reject" | "accept_daily" | "promote";

export interface PolicyResult {
  verdict: PolicyVerdict;
  score: number;
  rejectionReason?: string;
}

// ---------------------------------------------------------------------------
// Governance config surface
// (re-exported here so consumers can import from one place)
// ---------------------------------------------------------------------------

export type { GovernanceConfig } from "./config";
