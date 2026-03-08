import { describe, expect, it } from "vitest";
import { buildCandidate } from "./normalization";
import { DailyMemoryCompiler } from "./daily-compiler";
import type { CandidateStatus, MemoryCandidate, MemoryCandidateCategory } from "./types";

function makeCandidate(params: {
  id?: string;
  ts?: string;
  category: MemoryCandidateCategory;
  summary: string;
  dedupeKey?: string;
  status?: CandidateStatus;
}): MemoryCandidate {
  return buildCandidate({
    ts: params.ts ?? "2024-03-15T10:00:00Z",
    agentId: "mozi",
    source: "turn_completed",
    category: params.category,
    summary: params.summary,
    evidence: ["system_observed"],
    confidence: 0.8,
    stability: params.category === "preference" ? "high" : "medium",
    scopeHint: params.category === "preference" ? "long_term_candidate" : "daily",
    promoteCandidate: params.category === "preference",
    status: params.status ?? "accepted_daily",
    dedupeKey: params.dedupeKey,
    id: params.id,
  });
}

describe("DailyMemoryCompiler", () => {
  it("groups accepted candidates into deterministic daily sections", () => {
    const compiler = new DailyMemoryCompiler();
    const result = compiler.compile({
      date: "2024-03-15",
      candidates: [
        makeCandidate({ category: "decision", summary: "chose bun for runtime" }),
        makeCandidate({ category: "blocker", summary: "CI is failing on macOS" }),
        makeCandidate({ category: "active_work", summary: "implementing daily compiler" }),
        makeCandidate({ category: "tooling_fact", summary: "repo uses pnpm for scripts" }),
      ],
    });

    expect(result.candidates).toHaveLength(4);
    expect(result.markdown).toContain("# Daily Memory 2024-03-15");
    expect(result.markdown).toContain("## Active Work");
    expect(result.markdown).toContain("- implementing daily compiler");
    expect(result.markdown).toContain("## Blockers");
    expect(result.markdown).toContain("- CI is failing on macOS");
    expect(result.markdown).toContain("## Decisions");
    expect(result.markdown).toContain("- chose bun for runtime");
    expect(result.markdown).toContain("## Tooling Facts");
    expect(result.markdown).toContain("- repo uses pnpm for scripts");
  });

  it("dedupes candidates by dedupeKey deterministically", () => {
    const compiler = new DailyMemoryCompiler();
    const result = compiler.compile({
      date: "2024-03-15",
      candidates: [
        makeCandidate({
          category: "decision",
          summary: "use bun later",
          dedupeKey: "decision:use-bun",
          id: "b",
          ts: "2024-03-15T11:00:00Z",
        }),
        makeCandidate({
          category: "decision",
          summary: "use bun first",
          dedupeKey: "decision:use-bun",
          id: "a",
          ts: "2024-03-15T09:00:00Z",
        }),
      ],
    });

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]?.summary).toBe("use bun first");
    expect(result.markdown).toContain("- use bun first");
    expect(result.markdown).not.toContain("use bun later");
  });

  it("only includes candidates from the requested UTC date", () => {
    const compiler = new DailyMemoryCompiler();
    const result = compiler.compile({
      date: "2024-03-15",
      candidates: [
        makeCandidate({ category: "todo", summary: "finish compiler", ts: "2024-03-15T08:00:00Z" }),
        makeCandidate({ category: "todo", summary: "tomorrow item", ts: "2024-03-16T08:00:00Z" }),
      ],
    });

    expect(result.candidates).toHaveLength(1);
    expect(result.markdown).toContain("- finish compiler");
    expect(result.markdown).not.toContain("tomorrow item");
  });

  it("includes promoted non-daily-only categories but excludes promoted daily-only categories", () => {
    const compiler = new DailyMemoryCompiler();
    const result = compiler.compile({
      date: "2024-03-15",
      candidates: [
        makeCandidate({ category: "preference", summary: "prefer dark mode", status: "promoted" }),
        makeCandidate({ category: "todo", summary: "temporary task", status: "promoted" }),
      ],
    });

    expect(result.markdown).toContain("- prefer dark mode");
    expect(result.markdown).not.toContain("temporary task");
    expect(result.candidates.map((candidate) => candidate.category)).toEqual(["preference"]);
  });

  it("produces stable ordering by section then timestamp then summary", () => {
    const compiler = new DailyMemoryCompiler();
    const result = compiler.compile({
      date: "2024-03-15",
      candidates: [
        makeCandidate({ category: "lesson", summary: "z lesson", ts: "2024-03-15T11:00:00Z" }),
        makeCandidate({ category: "lesson", summary: "a lesson", ts: "2024-03-15T09:00:00Z" }),
        makeCandidate({ category: "decision", summary: "middle decision", ts: "2024-03-15T10:00:00Z" }),
      ],
    });

    expect(result.candidates.map((candidate) => candidate.summary)).toEqual([
      "middle decision",
      "a lesson",
      "z lesson",
    ]);
  });

  it("excludes pending and invalidated candidates", () => {
    const compiler = new DailyMemoryCompiler();
    const result = compiler.compile({
      date: "2024-03-15",
      candidates: [
        makeCandidate({ category: "decision", summary: "pending item", status: "pending" }),
        makeCandidate({ category: "decision", summary: "invalidated item", status: "invalidated" }),
      ],
    });

    expect(result.candidates).toHaveLength(0);
    expect(result.markdown).toBe("# Daily Memory 2024-03-15\n");
  });

  it("excludes long-term-only categories from daily output", () => {
    const compiler = new DailyMemoryCompiler();
    const result = compiler.compile({
      date: "2024-03-15",
      candidates: [
        makeCandidate({ category: "stable_rule", summary: "always write tests", status: "promoted" }),
        makeCandidate({ category: "long_term_project", summary: "ship governance system", status: "promoted" }),
      ],
    });

    expect(result.candidates).toHaveLength(0);
    expect(result.markdown).toBe("# Daily Memory 2024-03-15\n");
  });

  it("returns header-only markdown when no candidates qualify", () => {
    const compiler = new DailyMemoryCompiler();
    const result = compiler.compile({
      date: "2024-03-15",
      candidates: [
        makeCandidate({ category: "stable_rule", summary: "always write tests", status: "accepted_daily" }),
        makeCandidate({ category: "decision", summary: "rejected decision", status: "rejected" }),
      ],
    });

    expect(result.candidates).toHaveLength(0);
    expect(result.markdown).toBe("# Daily Memory 2024-03-15\n");
  });
});
