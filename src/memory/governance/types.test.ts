import { describe, it, expect } from "vitest";
import {
  normalizeSummary,
  generateDedupeKey,
  generateCandidateId,
  isTranscriptLike,
  isUrlDump,
  buildCandidate,
} from "./normalization";
import {
  DAILY_ONLY_CATEGORIES,
  DAILY_AND_PROMOTABLE_CATEGORIES,
  LONG_TERM_CANDIDATE_CATEGORIES,
  DAILY_ALLOWED_CATEGORIES,
  LONGTERM_SECTION_MAP,
} from "./types";
import { resolveGovernanceConfig, DEFAULT_GOVERNANCE_CONFIG } from "./config";

// ---------------------------------------------------------------------------
// normalizeSummary
// ---------------------------------------------------------------------------

describe("normalizeSummary", () => {
  it("lowercases the input", () => {
    expect(normalizeSummary("Always Use TypeScript")).toBe(
      "always use typescript"
    );
  });

  it("strips discourse prefixes", () => {
    expect(normalizeSummary("User said: prefer dark mode")).toBe(
      "prefer dark mode"
    );
    expect(normalizeSummary("Assistant noted: keep tests short")).toBe(
      "keep tests short"
    );
    expect(normalizeSummary("Note: deploy on Fridays")).toBe(
      "deploy on fridays"
    );
    expect(normalizeSummary("Summary: use pnpm")).toBe("use pnpm");
    expect(normalizeSummary("FYI: repo uses bun")).toBe("repo uses bun");
  });

  it("collapses whitespace", () => {
    expect(normalizeSummary("  use   pnpm  ")).toBe("use pnpm");
    expect(normalizeSummary("line one\nline two")).toBe("line one line two");
  });

  it("strips date fragments", () => {
    const result = normalizeSummary("Deployed on 2024-03-15");
    expect(result).not.toContain("2024-03-15");
    expect(result).toContain("deployed on");
  });

  it("strips large volatile numbers", () => {
    const result = normalizeSummary("session id 123456789 is active");
    expect(result).not.toContain("123456789");
  });

  it("preserves meaningful short numbers", () => {
    const result = normalizeSummary("use port 3000");
    expect(result).toContain("3000");
  });
});

// ---------------------------------------------------------------------------
// generateDedupeKey
// ---------------------------------------------------------------------------

describe("generateDedupeKey", () => {
  it("returns a 16-char hex string", () => {
    const key = generateDedupeKey("preference", "prefer dark mode", "agent1", "long_term_candidate");
    expect(key).toHaveLength(16);
    expect(/^[0-9a-f]+$/.test(key)).toBe(true);
  });

  it("is deterministic for the same inputs", () => {
    const a = generateDedupeKey("preference", "prefer dark mode", "agent1", "long_term_candidate");
    const b = generateDedupeKey("preference", "prefer dark mode", "agent1", "long_term_candidate");
    expect(a).toBe(b);
  });

  it("differs for different categories", () => {
    const a = generateDedupeKey("preference", "use pnpm", "agent1", "daily");
    const b = generateDedupeKey("stable_rule", "use pnpm", "agent1", "daily");
    expect(a).not.toBe(b);
  });

  it("differs for different agentIds", () => {
    const a = generateDedupeKey("preference", "use pnpm", "agentA", "daily");
    const b = generateDedupeKey("preference", "use pnpm", "agentB", "daily");
    expect(a).not.toBe(b);
  });

  it("normalizes summaries before hashing", () => {
    const a = generateDedupeKey("lesson", "User said: keep PRs small", "ag1", "daily");
    const b = generateDedupeKey("lesson", "keep PRs small", "ag1", "daily");
    expect(a).toBe(b);
  });

  // Spec-locking: same category+summary+agentId with different scopeHint must produce different keys
  it("differs for different scopeHint values (spec-required: daily vs long_term_candidate)", () => {
    const a = generateDedupeKey("preference", "use dark mode", "agent1", "daily");
    const b = generateDedupeKey("preference", "use dark mode", "agent1", "long_term_candidate");
    expect(a).not.toBe(b);
  });
});

// ---------------------------------------------------------------------------
// generateCandidateId
// ---------------------------------------------------------------------------

describe("generateCandidateId", () => {
  it("returns a 24-char hex string", () => {
    const id = generateCandidateId("abc123", "2024-03-15T10:00:00Z");
    expect(id).toHaveLength(24);
    expect(/^[0-9a-f]+$/.test(id)).toBe(true);
  });

  it("is deterministic", () => {
    const ts = "2024-03-15T10:00:00Z";
    const a = generateCandidateId("key1", ts);
    const b = generateCandidateId("key1", ts);
    expect(a).toBe(b);
  });

  it("same dedupeKey same day yields same id", () => {
    const a = generateCandidateId("key1", "2024-03-15T09:00:00Z");
    const b = generateCandidateId("key1", "2024-03-15T23:59:00Z");
    expect(a).toBe(b);
  });

  it("different days yield different ids", () => {
    const a = generateCandidateId("key1", "2024-03-15T09:00:00Z");
    const b = generateCandidateId("key1", "2024-03-16T09:00:00Z");
    expect(a).not.toBe(b);
  });

  // Spec-locking: same content same day from different sources must share the same ID
  it("same dedupeKey same day yields same id regardless of source (cross-path idempotency)", () => {
    const dedupeKey = "fixed-dedupe-key";
    const ts = "2024-03-15T10:00:00Z";
    // Simulate three different pipeline entry points emitting the same candidate
    const fromTurn = generateCandidateId(dedupeKey, ts);
    const fromReset = generateCandidateId(dedupeKey, ts);
    const fromCompact = generateCandidateId(dedupeKey, ts);
    expect(fromTurn).toBe(fromReset);
    expect(fromTurn).toBe(fromCompact);
  });
});

// ---------------------------------------------------------------------------
// isTranscriptLike
// ---------------------------------------------------------------------------

describe("isTranscriptLike", () => {
  it("detects repeated User: labels", () => {
    expect(
      isTranscriptLike("User: hello\nUser: how are you?")
    ).toBe(true);
  });

  it("detects repeated Assistant: labels", () => {
    expect(
      isTranscriptLike("Assistant: Hi there\nAssistant: Sure!")
    ).toBe(true);
  });

  it("detects User: + Assistant: combo", () => {
    expect(
      isTranscriptLike("User: do X\nAssistant: I did X")
    ).toBe(true);
  });

  it("returns false for a clean fact", () => {
    expect(isTranscriptLike("Always use pnpm instead of npm")).toBe(false);
  });

  it("returns false for a preference statement", () => {
    expect(isTranscriptLike("User prefers dark mode in all editors")).toBe(
      false
    );
  });
});

// ---------------------------------------------------------------------------
// isUrlDump
// ---------------------------------------------------------------------------

describe("isUrlDump", () => {
  it("detects bare URL", () => {
    expect(isUrlDump("https://example.com/page")).toBe(true);
  });

  it("detects URL with minimal surrounding text", () => {
    expect(isUrlDump("see https://example.com")).toBe(true);
  });

  it("returns false when URL has meaningful context", () => {
    expect(
      isUrlDump(
        "The project dashboard is at https://example.com/dashboard and tracks all issues"
      )
    ).toBe(false);
  });

  it("returns false for plain text with no URL", () => {
    expect(isUrlDump("use pnpm for package management")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// buildCandidate
// ---------------------------------------------------------------------------

describe("buildCandidate", () => {
  const base = {
    ts: "2024-03-15T10:00:00Z",
    agentId: "agent1",
    source: "turn_completed" as const,
    category: "preference" as const,
    summary: "prefer dark mode",
    evidence: ["user_explicit" as const],
    confidence: 0.9,
    stability: "high" as const,
    scopeHint: "long_term_candidate" as const,
    promoteCandidate: true,
  };

  it("generates id and dedupeKey automatically", () => {
    const c = buildCandidate(base);
    expect(c.id).toBeDefined();
    expect(c.id).toHaveLength(24);
    expect(c.dedupeKey).toBeDefined();
    expect(c.dedupeKey).toHaveLength(16);
  });

  it("defaults status to pending", () => {
    const c = buildCandidate(base);
    expect(c.status).toBe("pending");
  });

  it("respects provided id and dedupeKey", () => {
    const c = buildCandidate({ ...base, id: "custom-id", dedupeKey: "custom-key" });
    expect(c.id).toBe("custom-id");
    expect(c.dedupeKey).toBe("custom-key");
  });

  it("two calls with same inputs produce same id", () => {
    const a = buildCandidate(base);
    const b = buildCandidate(base);
    expect(a.id).toBe(b.id);
    expect(a.dedupeKey).toBe(b.dedupeKey);
  });
});

// ---------------------------------------------------------------------------
// Category mapping constants
// ---------------------------------------------------------------------------

describe("Category mapping constants", () => {
  it("DAILY_ONLY_CATEGORIES contains todo, blocker, active_work", () => {
    expect(DAILY_ONLY_CATEGORIES.has("todo")).toBe(true);
    expect(DAILY_ONLY_CATEGORIES.has("blocker")).toBe(true);
    expect(DAILY_ONLY_CATEGORIES.has("active_work")).toBe(true);
    expect(DAILY_ONLY_CATEGORIES.has("preference")).toBe(false);
  });

  it("LONG_TERM_CANDIDATE_CATEGORIES contains preference, stable_rule, tooling_fact, long_term_project", () => {
    expect(LONG_TERM_CANDIDATE_CATEGORIES.has("preference")).toBe(true);
    expect(LONG_TERM_CANDIDATE_CATEGORIES.has("stable_rule")).toBe(true);
    expect(LONG_TERM_CANDIDATE_CATEGORIES.has("tooling_fact")).toBe(true);
    expect(LONG_TERM_CANDIDATE_CATEGORIES.has("long_term_project")).toBe(true);
    expect(LONG_TERM_CANDIDATE_CATEGORIES.has("blocker")).toBe(false);
  });

  it("DAILY_AND_PROMOTABLE_CATEGORIES contains decision and lesson only", () => {
    expect(DAILY_AND_PROMOTABLE_CATEGORIES.has("decision")).toBe(true);
    expect(DAILY_AND_PROMOTABLE_CATEGORIES.has("lesson")).toBe(true);
    expect(DAILY_AND_PROMOTABLE_CATEGORIES.size).toBe(2);
  });

  it("daily-only categories are not in DAILY_AND_PROMOTABLE or LONG_TERM_CANDIDATE", () => {
    for (const cat of DAILY_ONLY_CATEGORIES) {
      expect(DAILY_AND_PROMOTABLE_CATEGORIES.has(cat)).toBe(false);
      expect(LONG_TERM_CANDIDATE_CATEGORIES.has(cat)).toBe(false);
    }
  });

  it("DAILY_ALLOWED_CATEGORIES includes all daily-only and daily-promotable", () => {
    for (const cat of DAILY_ONLY_CATEGORIES) {
      expect(DAILY_ALLOWED_CATEGORIES.has(cat)).toBe(true);
    }
    for (const cat of DAILY_AND_PROMOTABLE_CATEGORIES) {
      expect(DAILY_ALLOWED_CATEGORIES.has(cat)).toBe(true);
    }
  });

  it("LONGTERM_SECTION_MAP covers all long-term-candidate categories", () => {
    for (const cat of LONG_TERM_CANDIDATE_CATEGORIES) {
      expect(LONGTERM_SECTION_MAP[cat]).toBeDefined();
    }
  });

  it("LONGTERM_SECTION_MAP does NOT cover daily-only categories", () => {
    for (const cat of DAILY_ONLY_CATEGORIES) {
      expect(LONGTERM_SECTION_MAP[cat]).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// GovernanceConfig
// ---------------------------------------------------------------------------

describe("resolveGovernanceConfig", () => {
  it("returns defaults when called with no args", () => {
    const cfg = resolveGovernanceConfig();
    expect(cfg.enabled).toBe(true);
    expect(cfg.minConfidence).toBe(0.5);
    expect(cfg.promotionScoreThreshold).toBe(4);
    expect(cfg.autoPromoteOnUserExplicit).toBe(true);
  });

  it("merges partial config over defaults", () => {
    const cfg = resolveGovernanceConfig({ minConfidence: 0.8, enabled: false });
    expect(cfg.minConfidence).toBe(0.8);
    expect(cfg.enabled).toBe(false);
    // Unspecified fields remain at defaults
    expect(cfg.promotionScoreThreshold).toBe(
      DEFAULT_GOVERNANCE_CONFIG.promotionScoreThreshold
    );
  });

  it("does not mutate DEFAULT_GOVERNANCE_CONFIG", () => {
    const before = { ...DEFAULT_GOVERNANCE_CONFIG };
    resolveGovernanceConfig({ minConfidence: 0.99 });
    expect(DEFAULT_GOVERNANCE_CONFIG.minConfidence).toBe(before.minConfidence);
  });
});
