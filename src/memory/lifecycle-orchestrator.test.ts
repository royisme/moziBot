import { describe, expect, test, vi } from "vitest";
import type { ResolvedBuiltinMemoryConfig } from "./backend-config";
import type { MemorySearchManager } from "./types";
import { MemoryLifecycleOrchestrator } from "./lifecycle-orchestrator";

function makeManager(overrides?: Partial<MemorySearchManager>): MemorySearchManager {
  return {
    search: vi.fn(async () => []),
    readFile: vi.fn(async () => ({ path: "MEMORY.md", text: "" })),
    status: vi.fn(() => ({ backend: "builtin" as const, provider: "builtin" })),
    probeEmbeddingAvailability: vi.fn(async () => ({ ok: true })),
    probeVectorAvailability: vi.fn(async () => true),
    ...overrides,
  };
}

function makeBuiltinSync(
  override?: Partial<ResolvedBuiltinMemoryConfig["sync"]>,
): ResolvedBuiltinMemoryConfig {
  return {
    sync: {
      onSessionStart: true,
      onSearch: true,
      watch: true,
      watchDebounceMs: 1500,
      intervalMinutes: 0,
      forceOnFlush: true,
      ...override,
    },
  };
}

describe("MemoryLifecycleOrchestrator", () => {
  test("session_start triggers sync when enabled", async () => {
    const sync = vi.fn(async () => {});
    const manager = makeManager({ sync });
    const orchestrator = new MemoryLifecycleOrchestrator(manager, makeBuiltinSync());

    await orchestrator.handle({ type: "session_start", sessionKey: "s1" });

    expect(sync).toHaveBeenCalledTimes(1);
    expect(sync).toHaveBeenCalledWith({ reason: "session-start", force: false });
  });

  test("flush_completed marks dirty and force syncs when enabled", async () => {
    const sync = vi.fn(async () => {});
    const markDirty = vi.fn(() => {});
    const manager = makeManager({ sync, markDirty });
    const orchestrator = new MemoryLifecycleOrchestrator(manager, makeBuiltinSync());

    await orchestrator.handle({ type: "flush_completed", sessionKey: "s1" });

    expect(markDirty).toHaveBeenCalledTimes(1);
    expect(sync).toHaveBeenCalledTimes(1);
    expect(sync).toHaveBeenCalledWith({ reason: "flush", force: true });
  });

  test("flush_completed only marks dirty when forceOnFlush disabled", async () => {
    const sync = vi.fn(async () => {});
    const markDirty = vi.fn(() => {});
    const manager = makeManager({ sync, markDirty });
    const orchestrator = new MemoryLifecycleOrchestrator(
      manager,
      makeBuiltinSync({ forceOnFlush: false }),
    );

    await orchestrator.handle({ type: "flush_completed", sessionKey: "s1" });

    expect(markDirty).toHaveBeenCalledTimes(1);
    expect(sync).not.toHaveBeenCalled();
  });

  test("search_requested syncs only when dirty and enabled", async () => {
    const sync = vi.fn(async () => {});
    const statusDirty = vi.fn(() => ({
      backend: "builtin" as const,
      provider: "builtin",
      dirty: true,
    }));
    const managerDirty = makeManager({ sync, status: statusDirty });
    const orchestratorDirty = new MemoryLifecycleOrchestrator(managerDirty, makeBuiltinSync());

    await orchestratorDirty.handle({ type: "search_requested", sessionKey: "s1" });

    expect(sync).toHaveBeenCalledTimes(1);
    expect(sync).toHaveBeenCalledWith({ reason: "search", force: false });

    const syncClean = vi.fn(async () => {});
    const statusClean = vi.fn(() => ({
      backend: "builtin" as const,
      provider: "builtin",
      dirty: false,
    }));
    const managerClean = makeManager({ sync: syncClean, status: statusClean });
    const orchestratorClean = new MemoryLifecycleOrchestrator(managerClean, makeBuiltinSync());

    await orchestratorClean.handle({ type: "search_requested", sessionKey: "s2" });
    expect(syncClean).not.toHaveBeenCalled();

    const syncDisabled = vi.fn(async () => {});
    const managerDisabled = makeManager({
      sync: syncDisabled,
      status: vi.fn(() => ({ backend: "builtin" as const, provider: "builtin", dirty: true })),
    });
    const orchestratorDisabled = new MemoryLifecycleOrchestrator(
      managerDisabled,
      makeBuiltinSync({ onSearch: false }),
    );
    await orchestratorDisabled.handle({ type: "search_requested", sessionKey: "s3" });
    expect(syncDisabled).not.toHaveBeenCalled();
  });

  test("coalesces concurrent search_requested events into one sync", async () => {
    let release: (() => void) | undefined;
    const firstSync = new Promise<void>((resolve) => {
      release = resolve;
    });
    const sync = vi
      .fn<(params?: { reason?: string; force?: boolean }) => Promise<void>>()
      .mockImplementationOnce(async () => {
        await firstSync;
      })
      .mockImplementation(async () => {});
    const manager = makeManager({
      sync,
      status: vi.fn(() => ({ backend: "builtin" as const, provider: "builtin", dirty: true })),
    });
    const orchestrator = new MemoryLifecycleOrchestrator(manager, makeBuiltinSync());

    const p1 = orchestrator.handle({ type: "search_requested", sessionKey: "s1" });
    const p2 = orchestrator.handle({ type: "search_requested", sessionKey: "s1" });
    release?.();
    await Promise.all([p1, p2]);

    expect(sync).toHaveBeenCalledTimes(1);
  });

  test("queues force flush sync while another sync is in-flight", async () => {
    let release: (() => void) | undefined;
    const firstSync = new Promise<void>((resolve) => {
      release = resolve;
    });
    const sync = vi
      .fn<(params?: { reason?: string; force?: boolean }) => Promise<void>>()
      .mockImplementationOnce(async () => {
        await firstSync;
      })
      .mockImplementation(async () => {});
    const markDirty = vi.fn(() => {});
    const manager = makeManager({ sync, markDirty });
    const orchestrator = new MemoryLifecycleOrchestrator(manager, makeBuiltinSync());

    const p1 = orchestrator.handle({ type: "session_start", sessionKey: "s1" });
    const p2 = orchestrator.handle({ type: "flush_completed", sessionKey: "s1" });
    release?.();
    await Promise.all([p1, p2]);

    expect(markDirty).toHaveBeenCalledTimes(1);
    expect(sync).toHaveBeenCalledTimes(2);
    expect(sync).toHaveBeenNthCalledWith(1, { reason: "session-start", force: false });
    expect(sync).toHaveBeenNthCalledWith(2, { reason: "flush", force: true });
  });
});
