import { describe, expect, it, beforeEach } from "vitest";
import type { AcpRuntime, AcpRuntimeHandle } from "../runtime/types";
import { applyManagerRuntimeControls } from "./manager.runtime-controls";
import { RuntimeCache } from "./runtime-cache";
import type { CachedRuntimeState } from "./runtime-cache";
import { buildRuntimeConfigOptionPairs, buildRuntimeControlSignature } from "./runtime-options";

function createMockRuntimeState(): CachedRuntimeState {
  return {
    runtime: {} as AcpRuntime,
    handle: {
      sessionKey: "test:main",
      backend: "test",
      runtimeSessionName: "test-session",
    } as AcpRuntimeHandle,
    backend: "test",
    agent: "main",
    mode: "persistent",
  };
}

describe("RuntimeCache", () => {
  let cache: RuntimeCache;

  beforeEach(() => {
    cache = new RuntimeCache();
  });

  describe("size", () => {
    it("should return 0 for empty cache", () => {
      expect(cache.size()).toBe(0);
    });

    it("should return correct size after adding items", () => {
      cache.set("key1", createMockRuntimeState());
      cache.set("key2", createMockRuntimeState());
      expect(cache.size()).toBe(2);
    });

    it("should return correct size after removing items", () => {
      cache.set("key1", createMockRuntimeState());
      cache.set("key2", createMockRuntimeState());
      cache.clear("key1");
      expect(cache.size()).toBe(1);
    });
  });

  describe("has", () => {
    it("should return false for missing key", () => {
      expect(cache.has("nonexistent")).toBe(false);
    });

    it("should return true for existing key", () => {
      cache.set("key1", createMockRuntimeState());
      expect(cache.has("key1")).toBe(true);
    });
  });

  describe("get", () => {
    it("should return null for missing key", () => {
      expect(cache.get("nonexistent")).toBeNull();
    });

    it("should return state for existing key", () => {
      const state = createMockRuntimeState();
      cache.set("key1", state);
      expect(cache.get("key1")).toBe(state);
    });

    it("should touch the entry by default", () => {
      const now1 = Date.now();
      const state = createMockRuntimeState();
      cache.set("key1", state, { now: now1 });

      const now2 = now1 + 1000;
      cache.get("key1", { now: now2 });

      expect(cache.getLastTouchedAt("key1")).toBe(now2);
    });

    it("should not touch when touch is false", () => {
      const now1 = Date.now();
      const state = createMockRuntimeState();
      cache.set("key1", state, { now: now1 });

      const now2 = now1 + 1000;
      cache.get("key1", { touch: false, now: now2 });

      expect(cache.getLastTouchedAt("key1")).toBe(now1);
    });
  });

  describe("peek", () => {
    it("should return null for missing key", () => {
      expect(cache.peek("nonexistent")).toBeNull();
    });

    it("should return state without touching", () => {
      const now1 = Date.now();
      const state = createMockRuntimeState();
      cache.set("key1", state, { now: now1 });

      cache.peek("key1");

      expect(cache.getLastTouchedAt("key1")).toBe(now1);
    });
  });

  describe("getLastTouchedAt", () => {
    it("should return null for missing key", () => {
      expect(cache.getLastTouchedAt("nonexistent")).toBeNull();
    });

    it("should return last touched timestamp", () => {
      const now = Date.now();
      cache.set("key1", createMockRuntimeState(), { now });
      expect(cache.getLastTouchedAt("key1")).toBe(now);
    });
  });

  describe("set", () => {
    it("should add new entry", () => {
      const state = createMockRuntimeState();
      cache.set("key1", state);
      expect(cache.get("key1")).toBe(state);
    });

    it("should update existing entry", () => {
      const state1 = createMockRuntimeState();
      const state2 = createMockRuntimeState();
      cache.set("key1", state1);
      cache.set("key1", state2);
      expect(cache.get("key1")).toBe(state2);
    });

    it("should use current time by default", () => {
      const before = Date.now();
      cache.set("key1", createMockRuntimeState());
      const after = Date.now();
      const touched = cache.getLastTouchedAt("key1")!;
      expect(touched).toBeGreaterThanOrEqual(before);
      expect(touched).toBeLessThanOrEqual(after);
    });
  });

  describe("clear", () => {
    it("should remove entry", () => {
      cache.set("key1", createMockRuntimeState());
      cache.clear("key1");
      expect(cache.has("key1")).toBe(false);
      expect(cache.get("key1")).toBeNull();
    });

    it("should be idempotent", () => {
      cache.set("key1", createMockRuntimeState());
      cache.clear("key1");
      cache.clear("key1"); // Should not throw
      expect(cache.has("key1")).toBe(false);
    });
  });

  describe("snapshot", () => {
    it("should return empty array for empty cache", () => {
      const snapshot = cache.snapshot();
      expect(snapshot).toEqual([]);
    });

    it("should return all entries", () => {
      cache.set("key1", createMockRuntimeState());
      cache.set("key2", createMockRuntimeState());
      const snapshot = cache.snapshot();
      expect(snapshot.length).toBe(2);
    });

    it("should include idleMs calculation", () => {
      const now = Date.now();
      cache.set("key1", createMockRuntimeState(), { now });

      const snapshot = cache.snapshot({ now: now + 5000 });
      expect(snapshot[0].idleMs).toBe(5000);
    });
  });

  describe("runtime control selection semantics", () => {
    it("should keep selection signature stable for semantically equal options", () => {
      const a = buildRuntimeControlSignature({
        model: "gpt-4o",
        backendExtras: { z: "1", a: "2" },
      });
      const b = buildRuntimeControlSignature({
        model: "gpt-4o",
        backendExtras: { a: "2", z: "1" },
      });
      expect(a).toBe(b);
    });

    it("should throw when required config key is not advertised", async () => {
      const setConfigOption = async () => {};
      const runtime = {
        setConfigOption,
        getCapabilities: async () => ({
          controls: ["session/set_config_option"],
          configOptionKeys: ["model"],
        }),
      } as unknown as AcpRuntime;

      await expect(
        applyManagerRuntimeControls({
          sessionKey: "agent:main:acp:test",
          runtime,
          handle: {
            sessionKey: "agent:main:acp:test",
            backend: "test",
            runtimeSessionName: "test",
          },
          meta: {
            backend: "test",
            agent: "main",
            runtimeSessionName: "test",
            mode: "persistent",
            state: "idle",
            lastActivityAt: Date.now(),
            runtimeOptions: { permissionProfile: "strict" },
          },
          getCachedRuntimeState: () => null,
        }),
      ).rejects.toMatchObject({ code: "ACP_BACKEND_UNSUPPORTED_CONTROL" });
    });

    it("should throw on conflicting runtime option values", () => {
      expect(() =>
        buildRuntimeConfigOptionPairs({
          model: "gpt-4o",
          backendExtras: { model: "gpt-4.1" },
        }),
      ).toThrow("Conflicting runtime option");
    });
  });

  describe("collectIdleCandidates", () => {
    it("should return empty array when maxIdleMs is 0", () => {
      cache.set("key1", createMockRuntimeState());
      const candidates = cache.collectIdleCandidates({ maxIdleMs: 0 });
      expect(candidates).toEqual([]);
    });

    it("should return empty array when maxIdleMs is negative", () => {
      cache.set("key1", createMockRuntimeState());
      const candidates = cache.collectIdleCandidates({ maxIdleMs: -1000 });
      expect(candidates).toEqual([]);
    });

    it("should return entries older than maxIdleMs", () => {
      const now = Date.now();
      cache.set("old", createMockRuntimeState(), { now: now - 10000 });
      cache.set("new", createMockRuntimeState(), { now: now - 1000 });

      const candidates = cache.collectIdleCandidates({ maxIdleMs: 5000, now });
      expect(candidates.length).toBe(1);
      expect(candidates[0].actorKey).toBe("old");
    });

    it("should include idleMs in results", () => {
      const now = Date.now();
      cache.set("key1", createMockRuntimeState(), { now: now - 10000 });

      const candidates = cache.collectIdleCandidates({ maxIdleMs: 5000, now });
      expect(candidates[0].idleMs).toBe(10000);
    });
  });
});
