/**
 * MemoryPolicyEngine – validates and scores memory candidates.
 *
 * Phase 1 implementation: hard rejection rules + scoring model + verdict.
 * The full daily-compiler and promotion-queue integration (t5) builds on this.
 */

import type { MemoryCandidate, PolicyResult } from "./types";
import {
  DAILY_ONLY_CATEGORIES,
  LONG_TERM_CANDIDATE_CATEGORIES,
  DAILY_ALLOWED_CATEGORIES,
} from "./types";
import { isTranscriptLike, isUrlDump } from "./normalization";
import type { GovernanceConfig } from "./config";
import { resolveGovernanceConfig } from "./config";

// ---------------------------------------------------------------------------
// Scoring constants (matches spec example scoring model)
// ---------------------------------------------------------------------------

const SCORES: Record<string, number> = {
  evidence_user_explicit: 5,
  evidence_repeated_pattern: 4,
  category_preference: 4,
  category_stable_rule: 4,
  category_tooling_fact: 3,
  category_long_term_project: 2,
  stability_high: 2,
  category_decision: 1,
  category_lesson: 1,
  category_todo: -5,
  category_blocker: -5,
  category_active_work: -5,
  transcript_like: -10,
  ephemeral_state: -6,
};

// ---------------------------------------------------------------------------
// Ephemeral state detection
// ---------------------------------------------------------------------------

const EPHEMERAL_PATTERNS = [
  /\btemp(orary)?\b/i,
  /\bephemeral\b/i,
  /\bdo not persist\b/i,
  /\bone[- ]time\b/i,
  /\bsingle[- ]use\b/i,
  /\bthis session only\b/i,
];

function isEphemeralState(text: string): boolean {
  return EPHEMERAL_PATTERNS.some((re) => re.test(text));
}

// ---------------------------------------------------------------------------
// Score computation
// ---------------------------------------------------------------------------

interface ScoredCandidate {
  score: number;
  transcriptLike: boolean;
  ephemeral: boolean;
  urlDump: boolean;
}

/** Compute score and content flags in a single pass to avoid redundant regex work. */
function analyzeCandidate(candidate: MemoryCandidate): ScoredCandidate {
  const transcriptLike = isTranscriptLike(candidate.summary);
  const ephemeral = isEphemeralState(candidate.summary);
  const urlDump = isUrlDump(candidate.summary);

  let score = 0;

  // Evidence bonuses
  if (candidate.evidence.includes("user_explicit"))
    score += SCORES.evidence_user_explicit;
  if (candidate.evidence.includes("repeated_pattern"))
    score += SCORES.evidence_repeated_pattern;

  // Category bonuses / penalties
  const catKey = `category_${candidate.category}`;
  if (catKey in SCORES) score += SCORES[catKey];

  // Stability bonus
  if (candidate.stability === "high") score += SCORES.stability_high;

  // Penalties
  if (transcriptLike) score += SCORES.transcript_like;
  if (ephemeral) score += SCORES.ephemeral_state;

  return { score, transcriptLike, ephemeral, urlDump };
}

/** Compute score only (used by isPromotable when called externally with no pre-analysis). */
function computeScore(candidate: MemoryCandidate): number {
  return analyzeCandidate(candidate).score;
}

// ---------------------------------------------------------------------------
// MemoryPolicyEngine
// ---------------------------------------------------------------------------

export class MemoryPolicyEngine {
  private readonly cfg: GovernanceConfig;

  constructor(config?: Partial<GovernanceConfig>) {
    this.cfg = resolveGovernanceConfig(config);
  }

  /**
   * Evaluate a candidate and return a PolicyResult with verdict, score,
   * and optional rejection reason.
   */
  evaluate(candidate: MemoryCandidate): PolicyResult {
    // -----------------------------------------------------------------------
    // Confidence check (skip scoring entirely for cheap early exit)
    // -----------------------------------------------------------------------

    if (candidate.confidence < this.cfg.minConfidence) {
      return {
        verdict: "reject",
        score: 0,
        rejectionReason: `confidence ${candidate.confidence} below minimum ${this.cfg.minConfidence}`,
      };
    }

    // -----------------------------------------------------------------------
    // Single-pass analysis (score + content flags)
    // -----------------------------------------------------------------------
    const { score, transcriptLike, ephemeral, urlDump } =
      analyzeCandidate(candidate);

    // -----------------------------------------------------------------------
    // Hard rejections
    // -----------------------------------------------------------------------

    if (transcriptLike) {
      return { verdict: "reject", score, rejectionReason: "transcript-like content detected" };
    }

    if (urlDump) {
      return { verdict: "reject", score, rejectionReason: "URL dump without explanatory context" };
    }

    if (ephemeral) {
      return { verdict: "reject", score, rejectionReason: "ephemeral/temporary state content detected" };
    }

    // Hard rejection: forbidden categories in long-term write path
    if (
      candidate.scopeHint === "long_term_candidate" &&
      DAILY_ONLY_CATEGORIES.has(candidate.category)
    ) {
      return {
        verdict: "reject",
        score,
        rejectionReason: `category '${candidate.category}' is daily-only and cannot enter long-term memory`,
      };
    }

    // -----------------------------------------------------------------------
    // Verdict resolution
    // -----------------------------------------------------------------------

    if (this.isPromotable(candidate, score)) {
      return { verdict: "promote", score };
    }

    if (
      DAILY_ALLOWED_CATEGORIES.has(candidate.category) ||
      LONG_TERM_CANDIDATE_CATEGORIES.has(candidate.category)
    ) {
      return { verdict: "accept_daily", score };
    }

    return { verdict: "reject", score, rejectionReason: "no acceptance rule matched" };
  }

  /**
   * Batch evaluate, returning results in the same order as the input array.
   */
  evaluateBatch(
    candidates: MemoryCandidate[]
  ): Array<{ candidate: MemoryCandidate; result: PolicyResult }> {
    return candidates.map((c) => ({ candidate: c, result: this.evaluate(c) }));
  }

  // ---------------------------------------------------------------------------
  // Promotion eligibility check (exposed for testing)
  // ---------------------------------------------------------------------------

  isPromotable(candidate: MemoryCandidate, score?: number): boolean {
    // Daily-only categories can never be promoted regardless of evidence
    if (DAILY_ONLY_CATEGORIES.has(candidate.category)) return false;

    const s = score ?? computeScore(candidate);

    // Auto-promote on explicit user intent regardless of score
    if (
      this.cfg.autoPromoteOnUserExplicit &&
      candidate.evidence.includes("user_explicit")
    ) {
      return true;
    }

    // Score threshold
    if (s >= this.cfg.promotionScoreThreshold) {
      return true;
    }

    return false;
  }
}
