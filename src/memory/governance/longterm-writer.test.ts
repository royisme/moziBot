import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LongTermStore } from "./longterm-store";
import { LongTermMemoryWriter } from "./longterm-writer";
import { buildCandidate } from "./normalization";
import type { MemoryCandidate, MemoryCandidateCategory } from "./types";

function makeCandidate(params: {
  category: MemoryCandidateCategory;
  summary: string;
  ts?: string;
}): MemoryCandidate {
  return buildCandidate({
    ts: params.ts ?? "2024-03-15T10:00:00Z",
    agentId: "mozi",
    source: "turn_completed",
    category: params.category,
    summary: params.summary,
    evidence: ["user_explicit"],
    confidence: 0.9,
    stability: "high",
    scopeHint: "long_term_candidate",
    promoteCandidate: true,
    status: "promoted",
  });
}

describe("Long-term governance writer path", () => {
  let tempDir = "";
  let memoryDir = "";

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "mozi-longterm-"));
    memoryDir = path.join(tempDir, "memory");
    await fs.mkdir(memoryDir, { recursive: true });
  });

  afterEach(async () => {
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("stores promoted facts and prevents active duplicate dedupeKeys", async () => {
    const store = new LongTermStore(memoryDir);
    const first = makeCandidate({ category: "preference", summary: "prefer dark mode" });
    const second = makeCandidate({ category: "preference", summary: "prefer dark mode" });

    expect(await store.appendFromCandidate(first)).toBe(true);
    expect(await store.appendFromCandidate(second)).toBe(false);

    const facts = await store.readAll();
    expect(facts).toHaveLength(1);
    expect(facts[0]?.summary).toBe("prefer dark mode");
  });

  it("supports invalidation by dedupeKey", async () => {
    const store = new LongTermStore(memoryDir);
    const candidate = makeCandidate({ category: "stable_rule", summary: "always write tests" });
    await store.appendFromCandidate(candidate);

    expect(await store.invalidateByDedupeKey(candidate.dedupeKey)).toBe(true);
    const facts = await store.readAll();
    expect(facts[0]?.invalidated).toBe(true);
  });

  it("rejects daily-only categories from long-term storage", async () => {
    const store = new LongTermStore(memoryDir);
    await expect(
      store.appendFromCandidate(makeCandidate({ category: "todo", summary: "temporary task" })),
    ).rejects.toThrow("Daily-only category cannot be promoted to long-term storage: todo");
  });

  it("rebuilds MEMORY.md from active facts only with deterministic sections", async () => {
    const store = new LongTermStore(memoryDir);
    await store.appendFromCandidate(
      makeCandidate({ category: "tooling_fact", summary: "repo uses pnpm" }),
    );
    await store.appendFromCandidate(
      makeCandidate({ category: "preference", summary: "prefer dark mode" }),
    );
    await store.appendFromCandidate(
      makeCandidate({ category: "lesson", summary: "repeat lessons become durable" }),
    );

    const writer = new LongTermMemoryWriter(tempDir);
    const outputPath = await writer.rebuild(await store.readAll());
    const text = await fs.readFile(outputPath, "utf8");

    expect(text).toContain("# Memory");
    expect(text).toContain("## User Preferences");
    expect(text).toContain("- prefer dark mode");
    expect(text).toContain("## Tooling Facts");
    expect(text).toContain("- repo uses pnpm");
    expect(text).toContain("## Repeated Lessons");
    expect(text).toContain("- repeat lessons become durable");
  });

  it("excludes invalidated facts from rebuilt MEMORY.md", async () => {
    const store = new LongTermStore(memoryDir);
    const candidate = makeCandidate({
      category: "long_term_project",
      summary: "ship governance pipeline",
    });
    await store.appendFromCandidate(candidate);
    await store.invalidateByDedupeKey(candidate.dedupeKey);

    const writer = new LongTermMemoryWriter(tempDir);
    const outputPath = await writer.rebuild(await store.readAll());
    const text = await fs.readFile(outputPath, "utf8");

    expect(text).toBe("# Memory\n");
  });

  it("throws when rebuilding MEMORY.md with unsupported categories", () => {
    const writer = new LongTermMemoryWriter(tempDir);
    expect(() =>
      writer.buildMarkdown([
        {
          id: "fact-1",
          candidateId: "candidate-1",
          ts: "2024-03-15T10:00:00Z",
          agentId: "mozi",
          category: "todo",
          summary: "temporary task",
          dedupeKey: "todo:temporary-task",
          invalidated: false,
        },
      ]),
    ).toThrow("Unsupported long-term category: todo");
  });
});
