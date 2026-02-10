import { rmSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { BuiltinMemoryManager } from "../../memory/builtin-manager";
import { type MemoryToolsContext, memoryGet, memorySearch } from "./memory";

describe("Memory Tools", () => {
  let workspaceDir: string;
  let dbPath: string;
  let manager: BuiltinMemoryManager;
  let ctx: MemoryToolsContext;

  beforeEach(async () => {
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "mozi-memory-tools-"));
    dbPath = path.join(workspaceDir, "memory.db");

    await fs.writeFile(
      path.join(workspaceDir, "MEMORY.md"),
      "# Project Memory\n\nAlpha record: important note\nBeta record: another note",
    );

    manager = new BuiltinMemoryManager({ workspaceDir, dbPath });
    await manager.sync();

    ctx = {
      manager,
      sessionKey: "test-session",
    };
  });

  afterEach(async () => {
    await manager.close();
    rmSync(workspaceDir, { recursive: true, force: true });
  });

  test("memorySearch finds matching content", async () => {
    const response = await memorySearch(ctx, { query: "Alpha" });
    const results = response.results;
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].path).toBe("MEMORY.md");
    expect(results[0].snippet).toContain("Alpha");
  });

  test("memorySearch respects maxResults", async () => {
    const response = await memorySearch(ctx, { query: "record", maxResults: 1 });
    const results = response.results;
    expect(results.length).toBeLessThanOrEqual(1);
  });

  test("memorySearch triggers onSearchRequested hook when provided", async () => {
    const calls: string[] = [];
    const response = await memorySearch(
      {
        manager,
        sessionKey: "test-session",
        onSearchRequested: async () => {
          calls.push("search_requested");
        },
      } as MemoryToolsContext,
      { query: "Alpha" },
    );

    expect(calls).toEqual(["search_requested"]);
    expect(response.results.length).toBeGreaterThan(0);
  });

  test("memoryGet reads file content", async () => {
    const result = await memoryGet(ctx, {
      path: "MEMORY.md",
      from: 1,
      lines: 2,
    });
    expect(result.path).toBe("MEMORY.md");
    expect(result.text).toContain("Project Memory");
  });

  test("memoryGet rejects non-md files", async () => {
    await fs.writeFile(path.join(workspaceDir, "notes.txt"), "text file");
    await expect(memoryGet(ctx, { path: "notes.txt" })).rejects.toThrow("only .md");
  });
});
