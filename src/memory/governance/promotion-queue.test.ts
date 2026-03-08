import { describe, expect, it } from "vitest";
import { buildCandidate } from "./normalization";
import { PromotionQueue } from "./promotion-queue";
import type { MemoryCandidate, MemoryCandidateCategory } from "./types";

function makeCandidate(params: {
  category: MemoryCandidateCategory;
  summary: string;
  ts?: string;
  status?: MemoryCandidate["status"];
  promoteCandidate?: boolean;
}): MemoryCandidate {
  return buildCandidate({
    ts: params.ts ?? "2024-03-15T10:00:00Z",
    agentId: "mozi",
    source: "turn_completed",
    category: params.category,
    summary: params.summary,
    evidence: ["system_observed"],
    confidence: 0.8,
    stability: "medium",
    scopeHint: params.category === "preference" ? "long_term_candidate" : "daily",
    promoteCandidate: params.promoteCandidate ?? true,
    status: params.status ?? "pending",
  });
}

describe("PromotionQueue", () => {
  it("selects pending promotable candidates in deterministic order", () => {
    const queue = new PromotionQueue();
    const results = queue.select([
      makeCandidate({ category: "lesson", summary: "second", ts: "2024-03-15T11:00:00Z" }),
      makeCandidate({ category: "preference", summary: "first", ts: "2024-03-15T09:00:00Z" }),
      makeCandidate({ category: "todo", summary: "skip me" }),
    ]);

    expect(results.map((candidate) => candidate.summary)).toEqual(["first", "second"]);
  });

  it("excludes rejected, invalidated, and non-promote candidates", () => {
    const queue = new PromotionQueue();
    const results = queue.select([
      makeCandidate({ category: "preference", summary: "ok", status: "pending" }),
      makeCandidate({ category: "preference", summary: "rejected", status: "rejected" }),
      makeCandidate({ category: "decision", summary: "invalidated", status: "invalidated" }),
      makeCandidate({ category: "lesson", summary: "off", promoteCandidate: false }),
    ]);

    expect(results.map((candidate) => candidate.summary)).toEqual(["ok"]);
  });
});
