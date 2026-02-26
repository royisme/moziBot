import { describe, expect, test } from "vitest";
import type { MoziConfig } from "../config";
import { resolveMemoryBackendConfig } from "./backend-config";

function makeBaseConfig(): MoziConfig {
  return {
    paths: {
      baseDir: "/tmp/mozi-test",
    },
    models: {
      providers: {},
    },
    agents: {
      defaults: {
        model: "openai/gpt-4o-mini",
      },
      mozi: {
        skills: [],
      },
    },
    channels: {},
  } as unknown as MoziConfig;
}

describe("resolveMemoryBackendConfig builtin sync policy", () => {
  test("returns builtin sync defaults when not configured", () => {
    const cfg = makeBaseConfig();
    const resolved = resolveMemoryBackendConfig({ cfg, agentId: "mozi" });

    expect(resolved.builtin.sync).toEqual({
      onSessionStart: true,
      onSearch: true,
      watch: true,
      watchDebounceMs: 1500,
      intervalMinutes: 0,
      forceOnFlush: true,
    });
  });

  test("applies configured builtin sync overrides", () => {
    const cfg = makeBaseConfig();
    (cfg as { memory?: Record<string, unknown> }).memory = {
      backend: "builtin",
      builtin: {
        sync: {
          onSessionStart: false,
          onSearch: false,
          watch: false,
          watchDebounceMs: 250,
          intervalMinutes: 3,
          forceOnFlush: false,
        },
      },
    };

    const resolved = resolveMemoryBackendConfig({ cfg, agentId: "mozi" });
    expect(resolved.builtin.sync).toEqual({
      onSessionStart: false,
      onSearch: false,
      watch: false,
      watchDebounceMs: 250,
      intervalMinutes: 3,
      forceOnFlush: false,
    });
  });
});

describe("resolveMemoryBackendConfig qmd search mode", () => {
  test("defaults to search", () => {
    const cfg = makeBaseConfig();
    (cfg as { memory?: Record<string, unknown> }).memory = {
      backend: "qmd",
      qmd: {},
    };

    const resolved = resolveMemoryBackendConfig({ cfg, agentId: "mozi" });
    expect(resolved.qmd?.searchMode).toBe("search");
  });

  test("respects searchMode override", () => {
    const cfg = makeBaseConfig();
    (cfg as { memory?: Record<string, unknown> }).memory = {
      backend: "qmd",
      qmd: {
        searchMode: "vsearch",
      },
    };

    const resolved = resolveMemoryBackendConfig({ cfg, agentId: "mozi" });
    expect(resolved.qmd?.searchMode).toBe("vsearch");
  });
});

describe("resolveMemoryBackendConfig embedded defaults", () => {
  test("defaults to ollama provider when auto and no apiKey", () => {
    const cfg = makeBaseConfig();
    (cfg as { memory?: Record<string, unknown> }).memory = {
      backend: "embedded",
      embedded: {},
    };

    const resolved = resolveMemoryBackendConfig({ cfg, agentId: "mozi" });
    expect(resolved.backend).toBe("embedded");
    expect(resolved.embedded?.provider).toBe("ollama");
    expect(resolved.embedded?.remote.baseUrl).toBe("http://localhost:11434/v1");
    expect(resolved.embedded?.model).toBe("nomic-embed-text");
  });

  test("defaults to openai when apiKey is provided", () => {
    const cfg = makeBaseConfig();
    (cfg as { memory?: Record<string, unknown> }).memory = {
      backend: "embedded",
      embedded: {
        remote: {
          apiKey: "test-key",
        },
      },
    };

    const resolved = resolveMemoryBackendConfig({ cfg, agentId: "mozi" });
    expect(resolved.embedded?.provider).toBe("openai");
    expect(resolved.embedded?.remote.baseUrl).toBe("https://api.openai.com/v1");
    expect(resolved.embedded?.model).toBe("text-embedding-3-small");
  });
});
