import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { MoziConfig } from "../config";
import { resolveMemoryBackendConfig } from "./backend-config";
import { QmdMemoryManager } from "./qmd-manager";
import { runQmd } from "./qmd/qmd-client";

vi.mock("./qmd/qmd-client", async () => {
  const actual = await vi.importActual<typeof import("./qmd/qmd-client")>("./qmd/qmd-client");
  return {
    ...actual,
    runQmd: vi.fn(),
  };
});

vi.mock("./qmd/doc-resolver", () => {
  return {
    QmdDocResolver: class {
      async resolveDocLocation(docid?: string) {
        if (!docid) {
          return null;
        }
        const normalized = docid.startsWith("#") ? docid.slice(1) : docid;
        return {
          rel: `qmd/mock/${normalized}.md`,
          abs: `/tmp/${normalized}.md`,
          source: "memory" as const,
        };
      }
      readCounts() {
        return { totalDocuments: 0, sourceCounts: [] };
      }
      clearCache() {}
      close() {}
    },
  };
});

describe("QmdMemoryManager search behavior", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "mozi-qmd-search-"));
    vi.mocked(runQmd).mockReset();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test("fans out across collections and merges by best score", async () => {
    const alphaDir = path.join(tmpDir, "alpha");
    const bravoDir = path.join(tmpDir, "bravo");
    await fs.mkdir(alphaDir, { recursive: true });
    await fs.mkdir(bravoDir, { recursive: true });

    vi.mocked(runQmd).mockImplementation(async ({ args }) => {
      if (args[0] === "collection" && args[1] === "list") {
        return { stdout: "[]", stderr: "" };
      }
      if (args[0] === "collection" && args[1] === "add") {
        return { stdout: "", stderr: "" };
      }
      if (args[0] === "search") {
        const collectionIndex = args.indexOf("-c");
        const collection = collectionIndex >= 0 ? args[collectionIndex + 1] : undefined;
        if (collection === "alpha") {
          return {
            stdout: JSON.stringify([
              { docid: "doc-1", score: 0.4, snippet: "alpha one" },
              { docid: "doc-2", score: 0.9, snippet: "alpha two" },
            ]),
            stderr: "",
          };
        }
        if (collection === "bravo") {
          return {
            stdout: JSON.stringify([
              { docid: "doc-2", score: 0.5, snippet: "bravo two" },
              { docid: "doc-3", score: 0.8, snippet: "bravo three" },
            ]),
            stderr: "",
          };
        }
      }
      return { stdout: "[]", stderr: "" };
    });

    const cfg = {
      paths: { baseDir: tmpDir },
      models: { providers: {} },
      agents: {
        defaults: { model: "openai/gpt-4o-mini" },
        mozi: { skills: [] },
      },
      channels: {},
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: false,
          searchMode: "search",
          update: { onBoot: false, interval: "0" },
          paths: [
            { name: "alpha", path: alphaDir },
            { name: "bravo", path: bravoDir },
          ],
        },
      },
    } as const satisfies MoziConfig;

    const resolved = resolveMemoryBackendConfig({ cfg, agentId: "mozi" });
    const manager = await QmdMemoryManager.create({
      config: cfg,
      agentId: "mozi",
      resolved,
    });
    if (!manager) {
      throw new Error("qmd manager not created");
    }

    const results = await manager.search("hello", {
      sessionKey: "agent:mozi:telegram:dm:chat-1",
    });
    await manager.close();

    const searchCalls = vi.mocked(runQmd).mock.calls.filter((call) => call[0].args[0] === "search");
    expect(searchCalls).toHaveLength(2);
    expect(searchCalls[0]?.[0].args).toContain("alpha");
    expect(searchCalls[1]?.[0].args).toContain("bravo");

    expect(results.map((entry) => entry.path)).toEqual([
      "qmd/mock/doc-2.md",
      "qmd/mock/doc-3.md",
      "qmd/mock/doc-1.md",
    ]);
  });

  test("uses configured search mode command", async () => {
    const alphaDir = path.join(tmpDir, "alpha");
    await fs.mkdir(alphaDir, { recursive: true });

    vi.mocked(runQmd).mockImplementation(async ({ args }) => {
      if (args[0] === "collection" && args[1] === "list") {
        return { stdout: "[]", stderr: "" };
      }
      if (args[0] === "collection" && args[1] === "add") {
        return { stdout: "", stderr: "" };
      }
      if (args[0] === "vsearch") {
        return {
          stdout: JSON.stringify([{ docid: "doc-9", score: 1, snippet: "vector" }]),
          stderr: "",
        };
      }
      return { stdout: "[]", stderr: "" };
    });

    const cfg = {
      paths: { baseDir: tmpDir },
      models: { providers: {} },
      agents: {
        defaults: { model: "openai/gpt-4o-mini" },
        mozi: { skills: [] },
      },
      channels: {},
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: false,
          searchMode: "vsearch",
          update: { onBoot: false, interval: "0" },
          paths: [{ name: "alpha", path: alphaDir }],
        },
      },
    } as const satisfies MoziConfig;

    const resolved = resolveMemoryBackendConfig({ cfg, agentId: "mozi" });
    const manager = await QmdMemoryManager.create({
      config: cfg,
      agentId: "mozi",
      resolved,
    });
    if (!manager) {
      throw new Error("qmd manager not created");
    }

    const results = await manager.search("hello", {
      sessionKey: "agent:mozi:telegram:dm:chat-1",
    });
    await manager.close();

    const searchCalls = vi
      .mocked(runQmd)
      .mock.calls.filter((call) => call[0].args[0] === "vsearch");
    expect(searchCalls).toHaveLength(1);
    expect(results[0]?.path).toBe("qmd/mock/doc-9.md");
  });
});
