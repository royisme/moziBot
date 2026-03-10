import { describe, expect, it, beforeEach, vi } from "vitest";
import type { MoziConfig } from "../../config/schema";
import { AcpRuntimeError } from "../runtime/errors";
import type { AcpRuntime, AcpRuntimeHandle, AcpRuntimeEvent } from "../runtime/types";
import type { SessionAcpMeta } from "../types";
import { AcpSessionManager } from "./manager";
import type { AcpSessionManagerDeps } from "./manager.types";
import type { CachedRuntimeState } from "./runtime-cache";

// Mock store for session meta
const mockStore = new Map<string, { acp: SessionAcpMeta }>();

function createMockDeps(overrides?: Partial<AcpSessionManagerDeps>): AcpSessionManagerDeps {
  const mockReadSessionEntry = vi.fn(({ sessionKey }: { sessionKey: string }) => {
    const entry = mockStore.get(sessionKey);
    return entry ? { sessionKey, acp: entry.acp } : null;
  });

  const mockListAcpSessions = vi.fn(() => {
    const entries: Array<{ sessionKey: string; acp: SessionAcpMeta }> = [];
    for (const [key, value] of mockStore.entries()) {
      if (value.acp) {
        entries.push({ sessionKey: key, acp: value.acp });
      }
    }
    return entries;
  });

  const mockUpsertSessionMeta = vi.fn(
    ({
      sessionKey,
      mutate,
    }: {
      sessionKey: string;
      mutate: (current: SessionAcpMeta | undefined) => SessionAcpMeta | null | undefined;
    }) => {
      const current = mockStore.get(sessionKey);
      const result = mutate(current?.acp);
      if (result === null) {
        mockStore.delete(sessionKey);
        return null;
      }
      if (result === undefined) {
        return current?.acp ?? null;
      }
      mockStore.set(sessionKey, { acp: result });
      return result;
    },
  );

  const mockRequireRuntimeBackend = vi.fn((backendId?: string) => {
    const mockBackend = {
      id: backendId || "test-backend",
      runtime: createMockRuntime(),
      healthy: () => true,
    };
    return mockBackend;
  });

  return {
    listAcpSessions: mockListAcpSessions,
    readSessionEntry: mockReadSessionEntry,
    upsertSessionMeta: mockUpsertSessionMeta,
    requireRuntimeBackend: mockRequireRuntimeBackend,
    ...overrides,
  };
}

function createMockRuntime(overrides?: Partial<AcpRuntime>): AcpRuntime {
  const mockHandle: AcpRuntimeHandle = {
    sessionKey: "test:main",
    backend: "test-backend",
    runtimeSessionName: "test-session",
  };

  return {
    ensureSession: vi.fn(async () => mockHandle),
    runTurn: vi.fn(async function* () {
      // Proper lifecycle: started -> progress* -> done
      yield { type: "started", requestId: "req-test" };
      yield { type: "text_delta", text: "Hello" };
      yield { type: "done", stopReason: "stop" };
    }),
    cancel: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    getCapabilities: vi.fn(async () => ({
      controls: ["session/status", "session/set_mode", "session/set_config_option"],
      configOptionKeys: ["model", "approval_policy", "timeout"],
    })),
    getStatus: vi.fn(async () => ({
      summary: "idle",
      backendSessionId: "backend-123",
      agentSessionId: "agent-456",
    })),
    setMode: vi.fn(async () => {}),
    setConfigOption: vi.fn(async () => {}),
    doctor: vi.fn(async () => ({ ok: true, message: "healthy" })),
    ...overrides,
  } as AcpRuntime;
}

function createMockMeta(overrides?: Partial<SessionAcpMeta>): SessionAcpMeta {
  return {
    backend: "test-backend",
    agent: "main",
    runtimeSessionName: "test-session",
    mode: "persistent",
    state: "idle",
    lastActivityAt: Date.now(),
    ...overrides,
  };
}

describe("AcpSessionManager", () => {
  beforeEach(() => {
    mockStore.clear();
    vi.clearAllMocks();
  });

  describe("ensureSession", () => {
    it("should throw error when meta is missing", async () => {
      const manager = new AcpSessionManager(createMockDeps());

      await expect(
        manager.ensureSession({
          cfg: {} as MoziConfig,
          sessionKey: "test:main",
          agent: "main",
          mode: "persistent",
        }),
      ).rejects.toMatchObject({ code: "ACP_SESSION_INIT_FAILED" });
    });

    it("should ensure session and return handle when meta exists", async () => {
      const mockMeta = createMockMeta();
      mockStore.set("test:main", { acp: mockMeta });

      const manager = new AcpSessionManager(createMockDeps());
      const handle = await manager.ensureSession({
        cfg: {} as MoziConfig,
        sessionKey: "test:main",
        agent: "main",
        mode: "persistent",
      });

      expect(handle).toBeDefined();
      expect(handle.sessionKey).toBe("test:main");
    });

    it("should cache runtime instance after ensure", async () => {
      const mockMeta = createMockMeta();
      mockStore.set("test:main", { acp: mockMeta });

      const deps = createMockDeps();
      const manager = new AcpSessionManager(deps);

      await manager.ensureSession({
        cfg: {} as MoziConfig,
        sessionKey: "test:main",
        agent: "main",
        mode: "persistent",
      });

      // Second call should use cached runtime
      await manager.ensureSession({
        cfg: {} as MoziConfig,
        sessionKey: "test:main",
        agent: "main",
        mode: "persistent",
      });

      const requireBackend = deps.requireRuntimeBackend as ReturnType<typeof vi.fn>;
      expect(requireBackend).toHaveBeenCalledTimes(1);
    });

    it("should clear cache and re-ensure when identity mismatches cached handle", async () => {
      const mockMeta = createMockMeta();
      mockStore.set("test:main", { acp: mockMeta });

      const deps = createMockDeps();
      const manager = new AcpSessionManager(deps);

      await manager.ensureSession({
        cfg: {} as MoziConfig,
        sessionKey: "test:main",
        agent: "main",
        mode: "persistent",
      });

      const current = mockStore.get("test:main")?.acp;
      if (!current) {
        throw new Error("missing test meta");
      }
      mockStore.set("test:main", {
        acp: {
          ...current,
          identity: {
            state: "resolved",
            acpxSessionId: "changed-session-id",
            source: "status",
            lastUpdatedAt: Date.now(),
          },
        },
      });

      await manager.ensureSession({
        cfg: {} as MoziConfig,
        sessionKey: "test:main",
        agent: "main",
        mode: "persistent",
      });

      const requireBackend = deps.requireRuntimeBackend as ReturnType<typeof vi.fn>;
      expect(requireBackend).toHaveBeenCalledTimes(2);
    });

    it("should serialize concurrent ensure calls for same session", async () => {
      const mockMeta = createMockMeta();
      mockStore.set("test:main", { acp: mockMeta });

      const ensureSessionMock = vi.fn(async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return {
          sessionKey: "test:main",
          backend: "test-backend",
          runtimeSessionName: "test-session",
        };
      });
      const runtime = createMockRuntime({
        ensureSession: ensureSessionMock,
      });
      const deps = createMockDeps({
        requireRuntimeBackend: vi.fn(() => ({
          id: "test-backend",
          runtime,
          healthy: () => true,
        })),
      });
      const manager = new AcpSessionManager(deps);

      await Promise.all([
        manager.ensureSession({
          cfg: {} as MoziConfig,
          sessionKey: "test:main",
          agent: "main",
          mode: "persistent",
        }),
        manager.ensureSession({
          cfg: {} as MoziConfig,
          sessionKey: "test:main",
          agent: "main",
          mode: "persistent",
        }),
      ]);

      expect(ensureSessionMock).toHaveBeenCalledTimes(1);
    });

    it("should not leave dirty cache after ensure failure", async () => {
      const mockMeta = createMockMeta();
      mockStore.set("test:main", { acp: mockMeta });

      let shouldFail = true;
      const ensureSessionMock = vi.fn(async () => {
        if (shouldFail) {
          throw new Error("ensure failed");
        }
        return {
          sessionKey: "test:main",
          backend: "test-backend",
          runtimeSessionName: "test-session",
        };
      });
      const runtime = createMockRuntime({
        ensureSession: ensureSessionMock,
      });
      const deps = createMockDeps({
        requireRuntimeBackend: vi.fn(() => ({
          id: "test-backend",
          runtime,
          healthy: () => true,
        })),
      });
      const manager = new AcpSessionManager(deps);

      await expect(
        manager.ensureSession({
          cfg: {} as MoziConfig,
          sessionKey: "test:main",
          agent: "main",
          mode: "persistent",
        }),
      ).rejects.toBeInstanceOf(AcpRuntimeError);

      shouldFail = false;
      await manager.ensureSession({
        cfg: {} as MoziConfig,
        sessionKey: "test:main",
        agent: "main",
        mode: "persistent",
      });

      expect(ensureSessionMock).toHaveBeenCalledTimes(2);
    });
  });

  describe("runTurn", () => {
    it("should throw error when meta is missing", async () => {
      const manager = new AcpSessionManager(createMockDeps());

      await expect(
        manager.runTurn({
          cfg: {} as MoziConfig,
          sessionKey: "test:main",
          text: "hello",
          mode: "prompt",
          requestId: "req-1",
        }),
      ).rejects.toMatchObject({ code: "ACP_SESSION_INIT_FAILED" });
    });

    it("should execute turn and emit events", async () => {
      const mockMeta = createMockMeta();
      mockStore.set("test:main", { acp: mockMeta });

      const events: AcpRuntimeEvent[] = [];
      const manager = new AcpSessionManager(createMockDeps());

      await manager.runTurn({
        cfg: {} as MoziConfig,
        sessionKey: "test:main",
        text: "hello",
        mode: "prompt",
        requestId: "req-1",
        onEvent: (event) => {
          events.push(event);
        },
      });

      expect(events.length).toBeGreaterThan(0);
      expect(events.some((e) => e.type === "text_delta")).toBe(true);
      expect(events.some((e) => e.type === "done")).toBe(true);
    });

    it("should update meta state to running then idle", async () => {
      const mockMeta = createMockMeta();
      mockStore.set("test:main", { acp: mockMeta });

      const deps = createMockDeps();
      const manager = new AcpSessionManager(deps);

      await manager.runTurn({
        cfg: {} as MoziConfig,
        sessionKey: "test:main",
        text: "hello",
        mode: "prompt",
        requestId: "req-1",
      });

      const upsertMeta = deps.upsertSessionMeta as ReturnType<typeof vi.fn>;
      const calls = upsertMeta.mock.calls;

      // Should have been called at least twice (running, then idle)
      expect(calls.length).toBeGreaterThanOrEqual(2);

      // Check state transitions
      const states = calls.map(
        (c: unknown[]) =>
          (c[0] as { mutate: (m: SessionAcpMeta) => SessionAcpMeta | null }).mutate(mockMeta)
            ?.state,
      );
      expect(states).toContain("running");
      expect(states).toContain("idle");
    });

    it("should update meta state to error on failure", async () => {
      const mockMeta = createMockMeta();
      mockStore.set("test:main", { acp: mockMeta });

      const mockRuntime = createMockRuntime({
        runTurn: vi.fn(async function* (): AsyncGenerator<AcpRuntimeEvent> {
          yield* [] as AcpRuntimeEvent[];
          throw new Error("test error");
        }),
      });

      const deps = createMockDeps({
        requireRuntimeBackend: vi.fn(() => ({
          id: "test-backend",
          runtime: mockRuntime,
          healthy: () => true,
        })),
      });

      const manager = new AcpSessionManager(deps);

      await expect(
        manager.runTurn({
          cfg: {} as MoziConfig,
          sessionKey: "test:main",
          text: "hello",
          mode: "prompt",
          requestId: "req-1",
        }),
      ).rejects.toThrow("test error");

      const upsertMeta = deps.upsertSessionMeta as ReturnType<typeof vi.fn>;
      const calls = upsertMeta.mock.calls;

      // Check state transitions to error
      const states = calls.map(
        (c: unknown[]) =>
          (c[0] as { mutate: (m: SessionAcpMeta) => SessionAcpMeta | null }).mutate(mockMeta)
            ?.state,
      );
      expect(states).toContain("error");
    });

    it("should emit events in correct lifecycle order: started -> progress -> terminal", async () => {
      const mockMeta = createMockMeta();
      mockStore.set("test:main", { acp: mockMeta });

      const mockRuntime = createMockRuntime({
        runTurn: vi.fn(async function* (): AsyncGenerator<AcpRuntimeEvent> {
          yield { type: "started", requestId: "req-1" };
          yield { type: "text_delta", text: "Hello" };
          yield { type: "status", text: "working" };
          yield { type: "tool_call", text: "tool" };
          yield { type: "done", stopReason: "stop" };
        }),
      });

      const deps = createMockDeps({
        requireRuntimeBackend: vi.fn(() => ({
          id: "test-backend",
          runtime: mockRuntime,
          healthy: () => true,
        })),
      });

      const manager = new AcpSessionManager(deps);
      const events: AcpRuntimeEvent[] = [];

      await manager.runTurn({
        cfg: {} as MoziConfig,
        sessionKey: "test:main",
        text: "hello",
        mode: "prompt",
        requestId: "req-1",
        onEvent: (event) => {
          events.push(event);
        },
      });

      // Verify lifecycle order: started -> (progress)* -> done
      expect(events.length).toBe(5);
      expect(events[0]?.type).toBe("started");
      expect(events[1]?.type).toBe("text_delta");
      expect(events[2]?.type).toBe("status");
      expect(events[3]?.type).toBe("tool_call");
      expect(events[4]?.type).toBe("done");

      // Verify exactly one terminal event
      const terminalEvents = events.filter((e) => e.type === "done" || e.type === "error");
      expect(terminalEvents.length).toBe(1);
    });

    it("should emit error as terminal event when turn fails", async () => {
      const mockMeta = createMockMeta();
      mockStore.set("test:main", { acp: mockMeta });

      const mockRuntime = createMockRuntime({
        runTurn: vi.fn(async function* (): AsyncGenerator<AcpRuntimeEvent> {
          yield { type: "started", requestId: "req-1" };
          yield { type: "text_delta", text: "Partial" };
          yield {
            type: "error",
            message: "Runtime failed",
            code: "RUNTIME_ERR",
            category: "runtime",
          };
        }),
      });

      const deps = createMockDeps({
        requireRuntimeBackend: vi.fn(() => ({
          id: "test-backend",
          runtime: mockRuntime,
          healthy: () => true,
        })),
      });

      const manager = new AcpSessionManager(deps);
      const events: AcpRuntimeEvent[] = [];

      await manager.runTurn({
        cfg: {} as MoziConfig,
        sessionKey: "test:main",
        text: "hello",
        mode: "prompt",
        requestId: "req-1",
        onEvent: (event) => {
          events.push(event);
        },
      });

      // Verify error is the terminal event
      expect(events.length).toBe(3);
      expect(events[0]?.type).toBe("started");
      expect(events[1]?.type).toBe("text_delta");
      expect(events[2]?.type).toBe("error");
      expect((events[2] as { message: string }).message).toBe("Runtime failed");

      // Verify exactly one terminal event
      const terminalEvents = events.filter((e) => e.type === "done" || e.type === "error");
      expect(terminalEvents.length).toBe(1);
    });

    it("should keep terminal event unique even when runtime yields multiple terminal events", async () => {
      const mockMeta = createMockMeta();
      mockStore.set("test:main", { acp: mockMeta });

      const mockRuntime = createMockRuntime({
        runTurn: vi.fn(async function* (): AsyncGenerator<AcpRuntimeEvent> {
          yield { type: "started", requestId: "req-1" };
          yield { type: "done", stopReason: "stop" };
          yield { type: "error", message: "late", code: "LATE", category: "runtime" };
        }),
      });

      const deps = createMockDeps({
        requireRuntimeBackend: vi.fn(() => ({
          id: "test-backend",
          runtime: mockRuntime,
          healthy: () => true,
        })),
      });

      const manager = new AcpSessionManager(deps);
      const events: AcpRuntimeEvent[] = [];
      const onTerminal = vi.fn();

      await manager.runTurn({
        cfg: {} as MoziConfig,
        sessionKey: "test:main",
        text: "hello",
        mode: "prompt",
        requestId: "req-1",
        onEvent: (event) => {
          events.push(event);
        },
        onTerminal,
      });

      const terminalEvents = events.filter((e) => e.type === "done" || e.type === "error");
      expect(terminalEvents).toHaveLength(1);
      expect(terminalEvents[0]?.type).toBe("done");
      expect(onTerminal).toHaveBeenCalledTimes(1);
      expect(onTerminal).toHaveBeenCalledWith(
        expect.objectContaining({ terminal: "completed", reason: "stop" }),
      );
    });

    it("should normalize failed terminal exactly once from runtime error event", async () => {
      const mockMeta = createMockMeta();
      mockStore.set("test:main", { acp: mockMeta });

      const mockRuntime = createMockRuntime({
        runTurn: vi.fn(async function* (): AsyncGenerator<AcpRuntimeEvent> {
          yield { type: "started", requestId: "req-1" };
          yield {
            type: "error",
            message: "Runtime failed",
            code: "RUNTIME_ERR",
            category: "runtime",
          };
        }),
      });

      const deps = createMockDeps({
        requireRuntimeBackend: vi.fn(() => ({
          id: "test-backend",
          runtime: mockRuntime,
          healthy: () => true,
        })),
      });

      const manager = new AcpSessionManager(deps);
      const onTerminal = vi.fn();

      await manager.runTurn({
        cfg: {} as MoziConfig,
        sessionKey: "test:main",
        text: "hello",
        mode: "prompt",
        requestId: "req-1",
        onTerminal,
      });

      expect(onTerminal).toHaveBeenCalledTimes(1);
      expect(onTerminal).toHaveBeenCalledWith(
        expect.objectContaining({
          terminal: "failed",
          reason: "Runtime failed",
          errorCode: "RUNTIME_ERR",
        }),
      );
    });

    it("should normalize aborted terminal exactly once from cancelled runtime event", async () => {
      const mockMeta = createMockMeta();
      mockStore.set("test:main", { acp: mockMeta });

      const mockRuntime = createMockRuntime({
        runTurn: vi.fn(async function* (): AsyncGenerator<AcpRuntimeEvent> {
          yield { type: "started", requestId: "req-1" };
          yield {
            type: "error",
            message: "cancelled by user",
            code: "ACP_CANCELLED",
            category: "cancelled",
          };
        }),
      });

      const deps = createMockDeps({
        requireRuntimeBackend: vi.fn(() => ({
          id: "test-backend",
          runtime: mockRuntime,
          healthy: () => true,
        })),
      });

      const manager = new AcpSessionManager(deps);
      const onTerminal = vi.fn();

      await manager.runTurn({
        cfg: {} as MoziConfig,
        sessionKey: "test:main",
        text: "hello",
        mode: "prompt",
        requestId: "req-1",
        onTerminal,
      });

      expect(onTerminal).toHaveBeenCalledTimes(1);
      expect(onTerminal).toHaveBeenCalledWith(
        expect.objectContaining({
          terminal: "aborted",
          reason: "cancelled by user",
          errorCode: "ACP_CANCELLED",
        }),
      );
    });

    it("should normalize timeout terminal exactly once when aborted by timeout signal", async () => {
      const mockMeta = createMockMeta();
      mockStore.set("test:main", { acp: mockMeta });

      const timeoutError = new Error("acp-timeout");
      const mockRuntime = createMockRuntime({
        runTurn: vi.fn(async function* ({
          signal,
        }: {
          signal?: AbortSignal;
        }): AsyncGenerator<AcpRuntimeEvent> {
          yield { type: "started", requestId: "req-1" };
          if (signal?.aborted) {
            throw signal.reason;
          }
          throw timeoutError;
        }),
      });

      const deps = createMockDeps({
        requireRuntimeBackend: vi.fn(() => ({
          id: "test-backend",
          runtime: mockRuntime,
          healthy: () => true,
        })),
      });

      const manager = new AcpSessionManager(deps);
      const onTerminal = vi.fn();
      const controller = new AbortController();
      controller.abort("acp-timeout");

      await expect(
        manager.runTurn({
          cfg: {} as MoziConfig,
          sessionKey: "test:main",
          text: "hello",
          mode: "prompt",
          requestId: "req-1",
          signal: controller.signal,
          onTerminal,
        }),
      ).rejects.toBeDefined();

      expect(onTerminal).toHaveBeenCalledTimes(1);
      expect(onTerminal).toHaveBeenCalledWith(
        expect.objectContaining({ terminal: "timeout", reason: "acp-timeout" }),
      );
    });
  });

  describe("closeSession", () => {
    it("should close runtime and clear from cache", async () => {
      const mockMeta = createMockMeta();
      mockStore.set("test:main", { acp: mockMeta });

      const deps = createMockDeps();
      const manager = new AcpSessionManager(deps);

      // First ensure to populate cache
      await manager.ensureSession({
        cfg: {} as MoziConfig,
        sessionKey: "test:main",
        agent: "main",
        mode: "persistent",
      });

      // Then close
      const result = await manager.closeSession({
        cfg: {} as MoziConfig,
        sessionKey: "test:main",
        reason: "user requested",
      });

      expect(result.runtimeClosed).toBe(true);
      expect(result.metaCleared).toBe(false);
    });

    it("should clear meta when clearMeta is true", async () => {
      const mockMeta = createMockMeta();
      mockStore.set("test:main", { acp: mockMeta });

      const deps = createMockDeps();
      const manager = new AcpSessionManager(deps);

      await manager.ensureSession({
        cfg: {} as MoziConfig,
        sessionKey: "test:main",
        agent: "main",
        mode: "persistent",
      });

      const result = await manager.closeSession({
        cfg: {} as MoziConfig,
        sessionKey: "test:main",
        reason: "cleanup",
        clearMeta: true,
      });

      expect(result.metaCleared).toBe(true);
      expect(mockStore.has("test:main")).toBe(false);
    });

    it("should be idempotent on repeated close", async () => {
      const mockMeta = createMockMeta();
      mockStore.set("test:main", { acp: mockMeta });

      const deps = createMockDeps();
      const manager = new AcpSessionManager(deps);

      await manager.ensureSession({
        cfg: {} as MoziConfig,
        sessionKey: "test:main",
        agent: "main",
        mode: "persistent",
      });

      const first = await manager.closeSession({
        cfg: {} as MoziConfig,
        sessionKey: "test:main",
        reason: "cleanup",
      });
      const second = await manager.closeSession({
        cfg: {} as MoziConfig,
        sessionKey: "test:main",
        reason: "cleanup-again",
      });

      expect(first.runtimeClosed).toBe(true);
      expect(second.runtimeClosed).toBe(false);
    });
  });

  describe("getSessionStatus", () => {
    it("should return null when session does not exist", async () => {
      const manager = new AcpSessionManager(createMockDeps());
      const status = await manager.getSessionStatus("nonexistent:main");
      expect(status).toBeNull();
    });

    it("should return session status with meta info", async () => {
      const mockMeta = createMockMeta({
        identity: {
          state: "resolved",
          agentSessionId: "agent-123",
          source: "status",
          lastUpdatedAt: Date.now(),
        },
      });
      mockStore.set("test:main", { acp: mockMeta });

      const manager = new AcpSessionManager(createMockDeps());
      const status = await manager.getSessionStatus("test:main");

      expect(status).toBeDefined();
      expect(status?.sessionKey).toBe("test:main");
      expect(status?.backend).toBe("test-backend");
      expect(status?.agent).toBe("main");
      expect(status?.state).toBe("idle");
    });
  });

  describe("reconcileIdentities", () => {
    it("should reconcile all persisted session identities", async () => {
      const meta1 = createMockMeta({ agent: "main" });
      const meta2 = createMockMeta({ agent: "agent2" });
      mockStore.set("test:main", { acp: meta1 });
      mockStore.set("test:agent2", { acp: meta2 });

      const deps = createMockDeps();
      const manager = new AcpSessionManager(deps);

      const result = await manager.reconcileIdentities({} as MoziConfig);

      expect(result.checked).toBe(2);
      expect(result.resolved).toBe(2);
      expect(result.failed).toBe(0);
    });

    it("should handle reconcile failures gracefully", async () => {
      const mockMeta = createMockMeta();
      mockStore.set("test:main", { acp: mockMeta });

      const mockRuntime = createMockRuntime({
        ensureSession: vi.fn(async () => {
          throw new Error("ensure failed");
        }),
      });

      const deps = createMockDeps({
        requireRuntimeBackend: vi.fn(() => ({
          id: "test-backend",
          runtime: mockRuntime,
          healthy: () => true,
        })),
      });

      const manager = new AcpSessionManager(deps);
      const result = await manager.reconcileIdentities({} as MoziConfig);

      expect(result.checked).toBe(1);
      expect(result.failed).toBe(1);
    });
  });

  describe("updateRuntimeOptions", () => {
    it("should update runtime options in meta", async () => {
      const mockMeta = createMockMeta({
        runtimeOptions: {
          model: "gpt-4",
        },
      });
      mockStore.set("test:main", { acp: mockMeta });

      const deps = createMockDeps();
      const manager = new AcpSessionManager(deps);

      await manager.updateRuntimeOptions("test:main", {
        model: "gpt-4o",
        runtimeMode: "plan",
      });

      const updated = mockStore.get("test:main");
      expect(updated?.acp.runtimeOptions?.model).toBe("gpt-4o");
      expect(updated?.acp.runtimeOptions?.runtimeMode).toBe("plan");
    });

    it("should throw error when meta is missing", async () => {
      const manager = new AcpSessionManager(createMockDeps());

      await expect(
        manager.updateRuntimeOptions("test:main", {
          model: "gpt-4o",
        }),
      ).rejects.toMatchObject({ code: "ACP_SESSION_INIT_FAILED" });
    });
  });

  describe("cancelTurn", () => {
    it("should return false when no active turn", async () => {
      const manager = new AcpSessionManager(createMockDeps());
      const cancelled = await manager.cancelTurn("test:main", "user cancelled");
      expect(cancelled).toBe(false);
    });
  });

  describe("observability", () => {
    it("should return observability snapshot", async () => {
      const manager = new AcpSessionManager(createMockDeps());
      const snapshot = manager.getObservabilitySnapshot();

      expect(snapshot.runtimeCache.activeSessions).toBe(0);
      expect(snapshot.turns.active).toBe(0);
      expect(snapshot.turns.completed).toBe(0);
      expect(snapshot.turns.failed).toBe(0);
    });

    it("should track turn statistics", async () => {
      const mockMeta = createMockMeta();
      mockStore.set("test:main", { acp: mockMeta });

      const manager = new AcpSessionManager(createMockDeps());

      // Run multiple turns
      for (let i = 0; i < 3; i++) {
        await manager.runTurn({
          cfg: {} as MoziConfig,
          sessionKey: "test:main",
          text: `message ${i}`,
          mode: "prompt",
          requestId: `req-${i}`,
        });
      }

      const snapshot = manager.getObservabilitySnapshot();
      expect(snapshot.turns.completed).toBe(3);
      expect(snapshot.turns.averageLatencyMs).toBeGreaterThanOrEqual(0);
    });
  });

  describe("evictIdleRuntimes", () => {
    it("should not evict when TTL is 0", async () => {
      const manager = new AcpSessionManager(createMockDeps());
      const evicted = await manager.evictIdleRuntimes({} as MoziConfig);
      expect(evicted).toBe(0);
    });

    it("should evict stale runtime but keep active turn runtime", async () => {
      const manager = new AcpSessionManager(createMockDeps());
      const internal = manager as unknown as {
        runtimeCache: {
          set: (key: string, state: CachedRuntimeState, params?: { now?: number }) => void;
          has: (key: string) => boolean;
        };
        activeTurns: Map<string, unknown>;
      };

      const now = Date.now();
      internal.runtimeCache.set(
        "stale:main",
        {
          runtime: createMockRuntime(),
          handle: {
            sessionKey: "stale:main",
            backend: "test-backend",
            runtimeSessionName: "stale",
          },
          backend: "test-backend",
          agent: "main",
          mode: "persistent",
        },
        { now: now - 10 * 60 * 1000 },
      );
      internal.runtimeCache.set(
        "active:main",
        {
          runtime: createMockRuntime(),
          handle: {
            sessionKey: "active:main",
            backend: "test-backend",
            runtimeSessionName: "active",
          },
          backend: "test-backend",
          agent: "main",
          mode: "persistent",
        },
        { now: now - 10 * 60 * 1000 },
      );
      internal.activeTurns.set("active:main", {
        runtime: createMockRuntime(),
        handle: {
          sessionKey: "active:main",
          backend: "test-backend",
          runtimeSessionName: "active",
        },
        abortController: new AbortController(),
      });

      const evicted = await manager.evictIdleRuntimes({
        acp: {
          runtime: {
            ttlMinutes: 1,
          },
        },
      } as unknown as MoziConfig);

      expect(evicted).toBe(1);
      expect(internal.runtimeCache.has("stale:main")).toBe(false);
      expect(internal.runtimeCache.has("active:main")).toBe(true);
    });
  });

  describe("error boundary", () => {
    it("should wrap errors in AcpRuntimeError", async () => {
      const mockMeta = createMockMeta();
      mockStore.set("test:main", { acp: mockMeta });

      const mockRuntime = createMockRuntime({
        ensureSession: vi.fn(async () => {
          throw new Error("underlying error");
        }),
      });

      const deps = createMockDeps({
        requireRuntimeBackend: vi.fn(() => ({
          id: "test-backend",
          runtime: mockRuntime,
          healthy: () => true,
        })),
      });

      const manager = new AcpSessionManager(deps);

      try {
        await manager.ensureSession({
          cfg: {} as MoziConfig,
          sessionKey: "test:main",
          agent: "main",
          mode: "persistent",
        });
        expect.fail("should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(AcpRuntimeError);
        expect((error as AcpRuntimeError).code).toBe("ACP_SESSION_INIT_FAILED");
      }
    });
  });
});
