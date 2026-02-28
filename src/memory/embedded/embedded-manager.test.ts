import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import type { MoziConfig } from "../../config";
import type { EmbeddingProvider } from "./embedding-provider";
import { resolveMemoryBackendConfig } from "../backend-config";
import { EmbeddedMemoryManager } from "./embedded-manager";

function makeConfig(baseDir: string): MoziConfig {
  return {
    paths: { baseDir },
    models: { providers: {} },
    agents: {
      defaults: { model: "openai/gpt-4o-mini" },
      mozi: { skills: [] },
    },
    channels: {},
    memory: {
      backend: "embedded",
      embedded: {
        store: { vector: { enabled: false } },
        sync: { watch: false, onSearch: true, onSessionStart: false, intervalMinutes: 0 },
        query: { hybrid: { enabled: false } },
      },
    },
  } as unknown as MoziConfig;
}

describe("EmbeddedMemoryManager", () => {
  test("indexes memory file and returns vector search results", async () => {
    const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "mozi-embedded-"));
    const homeDir = path.join(baseDir, "agents", "mozi", "home");
    await fs.mkdir(homeDir, { recursive: true });
    await fs.writeFile(path.join(homeDir, "MEMORY.md"), "alpha note\nsecond line");

    const cfg = makeConfig(baseDir);
    const resolved = resolveMemoryBackendConfig({ cfg, agentId: "mozi" });
    const provider: EmbeddingProvider = {
      id: "openai",
      model: "test-embed",
      providerKey: "test",
      batchSize: 8,
      embed: async (texts) => texts.map((text) => (text.includes("alpha") ? [1, 0] : [0, 1])),
    };

    const manager = await EmbeddedMemoryManager.create({
      config: cfg,
      agentId: "mozi",
      resolved,
      providerFactory: async () => provider,
    });

    expect(manager).not.toBeNull();
    await manager?.sync({ reason: "test", force: true });
    const results = await manager?.search("alpha");
    expect(results?.length).toBeGreaterThan(0);
    expect(results?.[0]?.path).toBe("MEMORY.md");
    await manager?.close?.();
  });

  test("clamps overly long search query before embedding", async () => {
    const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "mozi-embedded-"));
    const homeDir = path.join(baseDir, "agents", "mozi", "home");
    await fs.mkdir(homeDir, { recursive: true });
    await fs.writeFile(path.join(homeDir, "MEMORY.md"), "alpha note");

    const cfg = makeConfig(baseDir);
    const resolved = resolveMemoryBackendConfig({ cfg, agentId: "mozi" });
    const provider: EmbeddingProvider = {
      id: "openai",
      model: "test-embed",
      providerKey: "test",
      batchSize: 8,
      embed: async (texts) => {
        const first = texts[0] ?? "";
        if (first.length > 1600) {
          throw new Error("the input length exceeds the context length");
        }
        return texts.map((text) => (text.includes("alpha") ? [1, 0] : [0, 1]));
      },
    };

    const manager = await EmbeddedMemoryManager.create({
      config: cfg,
      agentId: "mozi",
      resolved,
      providerFactory: async () => provider,
    });
    expect(manager).not.toBeNull();

    await manager?.sync({ reason: "test", force: true });
    const longQuery = "alpha ".repeat(1000);
    const results = await manager?.search(longQuery);
    expect(results?.length).toBeGreaterThan(0);
    await manager?.close?.();
  });
});
