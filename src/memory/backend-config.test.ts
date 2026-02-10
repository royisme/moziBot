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
