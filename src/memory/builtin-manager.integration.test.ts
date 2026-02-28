import { rmSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { BuiltinMemoryManager } from "./builtin-manager";

describe("BuiltinMemoryManager", () => {
  let workspaceDir: string;
  let dbPath: string;

  beforeEach(async () => {
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "mozi-memory-"));
    dbPath = path.join(workspaceDir, "memory.db");

    await fs.writeFile(path.join(workspaceDir, "MEMORY.md"), "Alpha line\nSecond line\n");

    await fs.mkdir(path.join(workspaceDir, "memory"), { recursive: true });
    await fs.writeFile(path.join(workspaceDir, "memory", "note.md"), "Beta entry\nMore text");
  });

  afterEach(() => {
    rmSync(workspaceDir, { recursive: true, force: true });
  });

  test("sync indexes workspace files and search finds matches", async () => {
    const manager = new BuiltinMemoryManager({ workspaceDir, dbPath });
    await manager.sync();

    const results = await manager.search("Alpha");
    expect(results.length).toBeGreaterThan(0);
    expect(results.some((r) => r.path === "MEMORY.md")).toBe(true);

    const noteResults = await manager.search("Beta");
    expect(noteResults.some((r) => r.path === "memory/note.md")).toBe(true);
  });

  test("markDirty + search re-syncs and picks up new files", async () => {
    const manager = new BuiltinMemoryManager({
      workspaceDir,
      dbPath,
      config: {
        sync: {
          onSessionStart: false,
          onSearch: true,
          watch: false,
          watchDebounceMs: 0,
          intervalMinutes: 0,
          forceOnFlush: true,
        },
      },
    });

    await manager.search("Alpha");
    await fs.writeFile(path.join(workspaceDir, "memory", "new.md"), "Gamma appeared");
    manager.markDirty?.();

    let found = false;
    for (let i = 0; i < 10; i += 1) {
      const results = await manager.search("Gamma");
      if (results.some((r) => r.path === "memory/new.md")) {
        found = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(found).toBe(true);
  });

  test("warmSession performs initial sync when enabled", async () => {
    const manager = new BuiltinMemoryManager({
      workspaceDir,
      dbPath,
      config: {
        sync: {
          onSessionStart: true,
          onSearch: false,
          watch: false,
          watchDebounceMs: 0,
          intervalMinutes: 0,
          forceOnFlush: true,
        },
      },
    });

    expect(manager.status().dirty).toBe(true);
    await manager.warmSession?.("session:test");
    expect(manager.status().dirty).toBe(false);

    const results = await manager.search("Beta");
    expect(results.some((r) => r.path === "memory/note.md")).toBe(true);
  });

  test("readFile enforces workspace and markdown restrictions", async () => {
    const manager = new BuiltinMemoryManager({ workspaceDir, dbPath });

    const read = await manager.readFile({
      relPath: "MEMORY.md",
      from: 1,
      lines: 1,
    });
    expect(read.text).toContain("Alpha");

    await fs.writeFile(path.join(workspaceDir, "note.txt"), "not allowed");
    await expect(manager.readFile({ relPath: "note.txt" })).rejects.toThrow("only .md");

    await expect(manager.readFile({ relPath: "../outside.md" })).rejects.toThrow("escapes");
  });

  test("readFile rejects symlinks", async () => {
    const manager = new BuiltinMemoryManager({ workspaceDir, dbPath });
    const target = path.join(workspaceDir, "memory", "target.md");
    const link = path.join(workspaceDir, "memory", "link.md");
    await fs.writeFile(target, "linked");
    await fs.symlink(target, link);

    await expect(manager.readFile({ relPath: "memory/link.md" })).rejects.toThrow(
      "invalid file type",
    );
  });

  test("falls back safely when FTS query parser rejects special tokens", async () => {
    await fs.writeFile(
      path.join(workspaceDir, "memory", "ops.md"),
      "pre-overflow memory flush keeps context stable",
    );
    const manager = new BuiltinMemoryManager({ workspaceDir, dbPath });
    await manager.sync();

    const results = await manager.search("pre-overflow memory flush");
    expect(results.some((r) => r.path === "memory/ops.md")).toBe(true);
  });
});
