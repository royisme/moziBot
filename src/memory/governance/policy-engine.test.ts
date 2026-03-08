import { describe, it, expect, beforeEach } from "vitest";
import { buildCandidate } from "./normalization";
import { MemoryPolicyEngine } from "./policy-engine";
import type { MemoryCandidate } from "./types";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeCandidate(overrides: Partial<MemoryCandidate> = {}): MemoryCandidate {
  return buildCandidate({
    ts: "2024-03-15T10:00:00Z",
    agentId: "agent1",
    source: "turn_completed",
    category: "preference",
    summary: "prefer dark mode in all editors",
    evidence: ["user_explicit"],
    confidence: 0.9,
    stability: "high",
    scopeHint: "long_term_candidate",
    promoteCandidate: true,
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Basic instantiation
// ---------------------------------------------------------------------------

describe("MemoryPolicyEngine – construction", () => {
  it("creates with default config", () => {
    const engine = new MemoryPolicyEngine();
    expect(engine).toBeDefined();
  });

  it("creates with partial config override", () => {
    const engine = new MemoryPolicyEngine({ minConfidence: 0.8 });
    expect(engine).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Hard rejections
// ---------------------------------------------------------------------------

describe("MemoryPolicyEngine – hard rejections", () => {
  let engine: MemoryPolicyEngine;

  beforeEach(() => {
    engine = new MemoryPolicyEngine();
  });

  it("rejects candidate below minConfidence", () => {
    const c = makeCandidate({ confidence: 0.2 });
    const r = engine.evaluate(c);
    expect(r.verdict).toBe("reject");
    expect(r.rejectionReason).toContain("confidence");
  });

  it("rejects transcript-like summary", () => {
    const c = makeCandidate({
      summary: "User: do X\nAssistant: I did X",
      confidence: 0.9,
    });
    const r = engine.evaluate(c);
    expect(r.verdict).toBe("reject");
    expect(r.rejectionReason).toContain("transcript");
  });

  it("rejects URL dump", () => {
    const c = makeCandidate({
      summary: "https://example.com/some/page",
      confidence: 0.9,
    });
    const r = engine.evaluate(c);
    expect(r.verdict).toBe("reject");
    expect(r.rejectionReason).toContain("URL");
  });

  it("rejects ephemeral state content", () => {
    const c = makeCandidate({
      summary: "temporary fix applied this session only",
      confidence: 0.9,
    });
    const r = engine.evaluate(c);
    expect(r.verdict).toBe("reject");
    expect(r.rejectionReason).toContain("ephemeral");
  });

  it("rejects daily-only category when scopeHint is long_term_candidate", () => {
    for (const cat of ["todo", "blocker", "active_work"] as const) {
      const c = makeCandidate({
        category: cat,
        scopeHint: "long_term_candidate",
        evidence: ["system_observed"],
      });
      const r = engine.evaluate(c);
      expect(r.verdict).toBe("reject");
      expect(r.rejectionReason).toContain("daily-only");
    }
  });
});

// ---------------------------------------------------------------------------
// Promotion
// ---------------------------------------------------------------------------

describe("MemoryPolicyEngine – promotion", () => {
  it("promotes high-confidence user_explicit preference", () => {
    const engine = new MemoryPolicyEngine();
    const c = makeCandidate({
      category: "preference",
      evidence: ["user_explicit"],
      confidence: 0.9,
      stability: "high",
    });
    const r = engine.evaluate(c);
    expect(r.verdict).toBe("promote");
  });

  it("promotes stable_rule with user_explicit evidence", () => {
    const engine = new MemoryPolicyEngine();
    const c = makeCandidate({
      category: "stable_rule",
      summary: "always write tests before merging",
      evidence: ["user_explicit"],
      confidence: 0.85,
    });
    const r = engine.evaluate(c);
    expect(r.verdict).toBe("promote");
  });

  it("promotes tooling_fact with high score", () => {
    const engine = new MemoryPolicyEngine();
    const c = makeCandidate({
      category: "tooling_fact",
      summary: "repo uses bun instead of node",
      evidence: ["user_explicit", "repeated_pattern"],
      confidence: 0.95,
      stability: "high",
    });
    const r = engine.evaluate(c);
    expect(r.verdict).toBe("promote");
  });

  it("does NOT promote todo even with user_explicit when autoPromote enabled", () => {
    const engine = new MemoryPolicyEngine({ autoPromoteOnUserExplicit: true });
    const c = makeCandidate({
      category: "todo",
      scopeHint: "long_term_candidate",
      evidence: ["user_explicit"],
    });
    const r = engine.evaluate(c);
    // Daily-only category → hard reject before promotion check
    expect(r.verdict).toBe("reject");
  });

  it("respects custom promotionScoreThreshold", () => {
    const engine = new MemoryPolicyEngine({
      promotionScoreThreshold: 100, // impossibly high
      autoPromoteOnUserExplicit: false,
    });
    const c = makeCandidate({
      category: "preference",
      evidence: ["user_explicit"],
      confidence: 0.9,
      stability: "high",
    });
    const r = engine.evaluate(c);
    // Score is sufficient but autoPromote is disabled and threshold is unbeatable
    expect(r.verdict).toBe("accept_daily");
  });
});

// ---------------------------------------------------------------------------
// Daily acceptance
// ---------------------------------------------------------------------------

describe("MemoryPolicyEngine – daily acceptance", () => {
  let engine: MemoryPolicyEngine;

  beforeEach(() => {
    engine = new MemoryPolicyEngine({
      autoPromoteOnUserExplicit: false,
      promotionScoreThreshold: 100, // disable auto-promote by threshold
    });
  });

  it("accepts_daily a valid decision", () => {
    const c = makeCandidate({
      category: "decision",
      summary: "chose pnpm over yarn for this project",
      evidence: ["user_confirmed"],
      confidence: 0.7,
      stability: "medium",
      scopeHint: "daily",
    });
    const r = engine.evaluate(c);
    expect(r.verdict).toBe("accept_daily");
  });

  it("accepts_daily a lesson", () => {
    const c = makeCandidate({
      category: "lesson",
      summary: "learned that bun test is faster than jest for unit tests",
      evidence: ["system_observed"],
      confidence: 0.6,
      stability: "low",
      scopeHint: "daily",
    });
    const r = engine.evaluate(c);
    expect(r.verdict).toBe("accept_daily");
  });

  it("accepts_daily a blocker scoped to daily", () => {
    const c = makeCandidate({
      category: "blocker",
      summary: "CI pipeline is failing due to flaky test",
      evidence: ["system_observed"],
      confidence: 0.8,
      stability: "low",
      scopeHint: "daily",
    });
    const r = engine.evaluate(c);
    expect(r.verdict).toBe("accept_daily");
  });

  it("accepts_daily an active_work entry", () => {
    const c = makeCandidate({
      category: "active_work",
      summary: "refactoring flush manager to separate concerns",
      evidence: ["system_observed"],
      confidence: 0.75,
      stability: "low",
      scopeHint: "daily",
    });
    const r = engine.evaluate(c);
    expect(r.verdict).toBe("accept_daily");
  });
});

// ---------------------------------------------------------------------------
// Score computation
// ---------------------------------------------------------------------------

describe("MemoryPolicyEngine – scoring", () => {
  it("returns positive score for high-quality candidate", () => {
    const engine = new MemoryPolicyEngine();
    const c = makeCandidate({
      category: "preference",
      evidence: ["user_explicit"],
      stability: "high",
      confidence: 0.9,
    });
    const r = engine.evaluate(c);
    expect(r.score).toBeGreaterThan(0);
  });

  it("returns lower score for transcript-like content than clean content of same category", () => {
    const engine = new MemoryPolicyEngine();
    const clean = makeCandidate({
      category: "preference",
      evidence: ["system_observed"],
      stability: "low",
      confidence: 0.9,
    });
    const transcript = makeCandidate({
      category: "preference",
      evidence: ["system_observed"],
      stability: "low",
      summary: "User: do this\nAssistant: ok done",
      confidence: 0.9,
    });
    const rClean = engine.evaluate(clean);
    const rTranscript = engine.evaluate(transcript);
    expect(rTranscript.verdict).toBe("reject");
    expect(rTranscript.score).toBeLessThan(rClean.score);
  });
});

// ---------------------------------------------------------------------------
// isPromotable helper
// ---------------------------------------------------------------------------

describe("MemoryPolicyEngine – isPromotable", () => {
  it("returns true for user_explicit with autoPromote enabled", () => {
    const engine = new MemoryPolicyEngine({ autoPromoteOnUserExplicit: true });
    const c = makeCandidate({ evidence: ["user_explicit"] });
    expect(engine.isPromotable(c)).toBe(true);
  });

  it("returns false for daily-only categories regardless of score", () => {
    const engine = new MemoryPolicyEngine({ autoPromoteOnUserExplicit: true });
    const c = makeCandidate({
      category: "blocker",
      evidence: ["user_explicit"],
      scopeHint: "daily",
    });
    // isPromotable checks daily-only restriction
    // Note: evaluate() would hard-reject long_term_candidate scope, but
    // isPromotable is a lower-level check used after scope guard.
    expect(engine.isPromotable(c)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Batch evaluation
// ---------------------------------------------------------------------------

describe("MemoryPolicyEngine – evaluateBatch", () => {
  it("returns results in same order as input", () => {
    const engine = new MemoryPolicyEngine();
    const c1 = makeCandidate({ category: "preference", evidence: ["user_explicit"] });
    const c2 = makeCandidate({
      category: "todo",
      scopeHint: "daily",
      evidence: ["system_observed"],
    });
    const c3 = makeCandidate({ confidence: 0.1 });

    const results = engine.evaluateBatch([c1, c2, c3]);
    expect(results).toHaveLength(3);
    expect(results[0].candidate.id).toBe(c1.id);
    expect(results[1].candidate.id).toBe(c2.id);
    expect(results[2].candidate.id).toBe(c3.id);
    expect(results[2].result.verdict).toBe("reject");
  });
});
