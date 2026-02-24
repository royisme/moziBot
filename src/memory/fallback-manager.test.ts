import { describe, expect, it, vi } from "vitest";
import type { MemorySearchManager, MemorySearchResult } from "./types";
import { FallbackMemoryManager } from "./fallback-manager";
import { expandQueryForFts } from "./query-expansion";

function createResult(path: string, score = 0.9): MemorySearchResult {
  return {
    path,
    startLine: 1,
    endLine: 1,
    score,
    snippet: "snippet",
    source: "memory",
  };
}

function createPrimary(results: MemorySearchResult[]): MemorySearchManager {
  return {
    search: vi.fn(async () => results),
    readFile: vi.fn(async () => ({ text: "", path: "MEMORY.md" })),
    status: vi.fn(() => ({
      backend: "qmd",
      provider: "qmd",
      custom: { qmd: {} },
    })),
    sync: vi.fn(async () => {}),
    probeEmbeddingAvailability: vi.fn(async () => ({ ok: true })),
    probeVectorAvailability: vi.fn(async () => true),
    close: vi.fn(async () => {}),
  };
}

function createFallback(params: { results: MemorySearchResult[]; ftsAvailable: boolean }) {
  const search = vi.fn(async () => params.results);
  const manager: MemorySearchManager = {
    search,
    readFile: vi.fn(async () => ({ text: "", path: "MEMORY.md" })),
    status: vi.fn(() => ({
      backend: "builtin",
      provider: "builtin",
      fts: { enabled: true, available: params.ftsAvailable },
    })),
    sync: vi.fn(async () => {}),
    probeEmbeddingAvailability: vi.fn(async () => ({ ok: true })),
    probeVectorAvailability: vi.fn(async () => false),
    close: vi.fn(async () => {}),
  };
  return { manager, search };
}

describe("FallbackMemoryManager low recall fallback", () => {
  it("falls back on low recall and expands query when FTS is available", async () => {
    const primary = createPrimary([createResult("primary.md")]);
    const { manager: fallback, search: fallbackSearch } = createFallback({
      results: [createResult("fallback-1.md"), createResult("fallback-2.md")],
      ftsAvailable: true,
    });
    const fallbackFactory = vi.fn(async () => fallback);

    const manager = new FallbackMemoryManager({ primary, fallbackFactory });
    const query = "that API we discussed";
    const expanded = expandQueryForFts(query).expanded;
    const results = await manager.search(query, { maxResults: 3 });

    expect(fallbackFactory).toHaveBeenCalledTimes(1);
    expect(fallbackSearch).toHaveBeenCalledTimes(1);
    expect(fallbackSearch.mock.calls[0]?.[0]).toBe(expanded);
    expect(results.map((entry) => entry.path)).toEqual([
      "primary.md",
      "fallback-1.md",
      "fallback-2.md",
    ]);
  });

  it("uses original query when FTS is unavailable", async () => {
    const primary = createPrimary([createResult("primary.md")]);
    const { manager: fallback, search: fallbackSearch } = createFallback({
      results: [createResult("fallback-1.md")],
      ftsAvailable: false,
    });
    const manager = new FallbackMemoryManager({
      primary,
      fallbackFactory: async () => fallback,
    });

    const query = "that API we discussed";
    await manager.search(query, { maxResults: 3 });

    expect(fallbackSearch).toHaveBeenCalledTimes(1);
    expect(fallbackSearch.mock.calls[0]?.[0]).toBe(query);
  });

  it("skips fallback when recall meets threshold", async () => {
    const primary = createPrimary([createResult("primary-1.md"), createResult("primary-2.md")]);
    const { manager: fallback, search: fallbackSearch } = createFallback({
      results: [createResult("fallback-1.md")],
      ftsAvailable: true,
    });
    const manager = new FallbackMemoryManager({
      primary,
      fallbackFactory: async () => fallback,
    });

    const results = await manager.search("hello", { maxResults: 4 });

    expect(results.map((entry) => entry.path)).toEqual(["primary-1.md", "primary-2.md"]);
    expect(fallbackSearch).not.toHaveBeenCalled();
  });
});
