import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { applyRecallPostProcessing } from "./recall";
import type { MemorySearchResult } from "./types";

const NOW = new Date(Date.UTC(2026, 1, 10));
const DAY_MS = 24 * 60 * 60 * 1000;

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mozi-recall-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map(async (dir) => {
      await fs.rm(dir, { recursive: true, force: true });
    }),
  );
});

function makeResult(params: Partial<MemorySearchResult> & { path: string; score: number }): MemorySearchResult {
  return {
    path: params.path,
    startLine: params.startLine ?? 1,
    endLine: params.endLine ?? 1,
    score: params.score,
    snippet: params.snippet ?? "",
    source: params.source ?? "memory",
  };
}

describe("applyRecallPostProcessing", () => {
  test("returns empty results unchanged", async () => {
    const processed = await applyRecallPostProcessing({
      query: "empty",
      results: [],
      recall: { mmr: { enabled: true, lambda: 0.7 } },
    });

    expect(processed).toEqual([]);
  });

  test("matches half-life decay for daily memory files", async () => {
    const results = [
      makeResult({
        path: "memory/2026-01-11.md",
        score: 1,
        snippet: "half-life",
      }),
    ];

    const processed = await applyRecallPostProcessing({
      query: "decay",
      results,
      recall: {
        temporalDecay: { enabled: true, halfLifeDays: 30 },
      },
      now: NOW,
    });

    expect(processed[0]?.score).toBeCloseTo(0.5, 2);
  });

  test("does not decay evergreen memory files", async () => {
    const results = [
      makeResult({
        path: "MEMORY.md",
        score: 0.9,
        snippet: "root memory",
      }),
      makeResult({
        path: "memory/projects.md",
        score: 0.8,
        snippet: "project notes",
      }),
    ];

    const processed = await applyRecallPostProcessing({
      query: "evergreen",
      results,
      recall: {
        temporalDecay: { enabled: true, halfLifeDays: 30 },
      },
      now: NOW,
    });

    expect(processed[0]?.score).toBeCloseTo(0.9);
    expect(processed[1]?.score).toBeCloseTo(0.8);
  });

  test("does not decay future dates", async () => {
    const results = [
      makeResult({
        path: "memory/2099-01-01.md",
        score: 0.75,
        snippet: "future",
      }),
    ];

    const processed = await applyRecallPostProcessing({
      query: "future",
      results,
      recall: {
        temporalDecay: { enabled: true, halfLifeDays: 30 },
      },
      now: NOW,
    });

    expect(processed[0]?.score).toBeCloseTo(0.75);
  });

  test("uses mtime fallback for non-memory paths when resolver is provided", async () => {
    const dir = await makeTempDir();
    const sessionPath = path.join(dir, "sessions", "thread.jsonl");
    await fs.mkdir(path.dirname(sessionPath), { recursive: true });
    await fs.writeFile(sessionPath, "{}\n");
    const oldMtime = new Date(NOW.getTime() - 30 * DAY_MS);
    await fs.utimes(sessionPath, oldMtime, oldMtime);

    const processed = await applyRecallPostProcessing({
      query: "sessions",
      results: [
        makeResult({
          path: "sessions/thread.jsonl",
          score: 1,
          snippet: "session data",
          source: "sessions",
        }),
      ],
      recall: {
        temporalDecay: { enabled: true, halfLifeDays: 30 },
      },
      now: NOW,
      resolveAbsolutePath: (relPath) => path.join(dir, relPath),
    });

    expect(processed[0]?.score).toBeCloseTo(0.5, 2);
  });

  test("temporal decay boosts recent daily memory files", async () => {
    const results = [
      makeResult({
        path: "memory/2025-10-10.md",
        score: 0.95,
        snippet: "old note",
      }),
      makeResult({
        path: "memory/2026-02-09.md",
        score: 0.6,
        snippet: "recent note",
      }),
    ];

    const processed = await applyRecallPostProcessing({
      query: "network setup",
      results,
      recall: {
        temporalDecay: { enabled: true, halfLifeDays: 30 },
      },
      now: NOW,
    });

    expect(processed[0]?.path).toBe("memory/2026-02-09.md");
  });

  test("mmr respects disabled config", async () => {
    const results = [
      makeResult({ path: "memory/a.md", score: 0.9, snippet: "alpha" }),
      makeResult({ path: "memory/b.md", score: 0.8, snippet: "alpha" }),
    ];

    const processed = await applyRecallPostProcessing({
      query: "alpha",
      results,
      recall: {
        mmr: { enabled: false, lambda: 0.3 },
      },
    });

    expect(processed.map((entry) => entry.path)).toEqual(["memory/a.md", "memory/b.md"]);
  });

  test("mmr clamps lambda above 1 to relevance-only ordering", async () => {
    const results = [
      makeResult({ path: "memory/a.md", score: 0.9, snippet: "alpha beta" }),
      makeResult({ path: "memory/b.md", score: 0.8, snippet: "alpha beta" }),
      makeResult({ path: "memory/c.md", score: 0.7, snippet: "gamma delta" }),
    ];

    const processed = await applyRecallPostProcessing({
      query: "alpha",
      results,
      recall: {
        mmr: { enabled: true, lambda: 1.5 },
      },
    });

    expect(processed.map((entry) => entry.path)).toEqual([
      "memory/a.md",
      "memory/b.md",
      "memory/c.md",
    ]);
  });

  test("mmr clamps lambda below 0 to maximize diversity", async () => {
    const results = [
      makeResult({ path: "memory/a.md", score: 0.9, snippet: "router vlan iot" }),
      makeResult({ path: "memory/b.md", score: 0.85, snippet: "router vlan iot" }),
      makeResult({ path: "memory/c.md", score: 0.8, snippet: "dns filter list" }),
    ];

    const processed = await applyRecallPostProcessing({
      query: "network",
      results,
      recall: {
        mmr: { enabled: true, lambda: -0.2 },
      },
    });

    expect(processed[0]?.path).toBe("memory/a.md");
    expect(processed[1]?.path).toBe("memory/c.md");
  });

  test("mmr favors diverse snippets after the top result", async () => {
    const results = [
      makeResult({
        path: "memory/2026-02-10.md",
        score: 0.9,
        snippet: "router vlan iot",
      }),
      makeResult({
        path: "memory/2026-02-09.md",
        score: 0.85,
        snippet: "router vlan iot",
      }),
      makeResult({
        path: "memory/2026-02-08.md",
        score: 0.8,
        snippet: "adguard dns filter",
      }),
    ];

    const processed = await applyRecallPostProcessing({
      query: "home network",
      results,
      recall: {
        mmr: { enabled: true, lambda: 0.7 },
      },
    });

    expect(processed[0]?.path).toBe("memory/2026-02-10.md");
    expect(processed[1]?.path).toBe("memory/2026-02-08.md");
  });

  test("writes metrics when enabled", async () => {
    const dir = await makeTempDir();
    const originalCwd = process.cwd();
    process.chdir(dir);

    try {
      const processed = await applyRecallPostProcessing({
        query: "metrics",
        results: [makeResult({ path: "memory/a.md", score: 0.9, snippet: "alpha" })],
        recall: {
          metrics: { enabled: true, sampleRate: 1 },
        },
      });

      expect(processed).toHaveLength(1);

      const logPath = path.join(dir, "data", "metrics", "memory-recall.jsonl");
      const content = await fs.readFile(logPath, "utf-8");
      expect(content.length).toBeGreaterThan(0);
      expect(content).toContain("\"memory_recall_metrics\"");
      expect(content).toContain("\"metrics\"");
    } finally {
      process.chdir(originalCwd);
    }
  });

  test("skips metrics when sampleRate is 0", async () => {
    const dir = await makeTempDir();
    const originalCwd = process.cwd();
    process.chdir(dir);

    try {
      await applyRecallPostProcessing({
        query: "metrics",
        results: [makeResult({ path: "memory/a.md", score: 0.9, snippet: "alpha" })],
        recall: {
          metrics: { enabled: true, sampleRate: 0 },
        },
      });

      const logPath = path.join(dir, "data", "metrics", "memory-recall.jsonl");
      await expect(fs.readFile(logPath, "utf-8")).rejects.toThrow();
    } finally {
      process.chdir(originalCwd);
    }
  });
});
