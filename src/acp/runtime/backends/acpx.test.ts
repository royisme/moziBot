import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { AcpxRuntimeBackend } from "./acpx";

vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
}));

function createMockProc(params?: {
  stdoutData?: string[];
  stderrData?: string[];
  closeCode?: number | null;
}) {
  const { stdoutData = [], stderrData = [], closeCode = 0 } = params ?? {};

  const proc = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: ReturnType<typeof vi.fn>;
  };
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = vi.fn();

  queueMicrotask(() => {
    for (const chunk of stdoutData) {
      proc.stdout.emit("data", Buffer.from(chunk));
    }
    for (const chunk of stderrData) {
      proc.stderr.emit("data", Buffer.from(chunk));
    }
    proc.emit("close", closeCode);
  });

  return proc as unknown as ReturnType<typeof spawn>;
}

describe("AcpxRuntimeBackend", () => {
  let backend: AcpxRuntimeBackend;

  beforeEach(() => {
    backend = new AcpxRuntimeBackend();
    vi.clearAllMocks();
  });

  describe("doctor", () => {
    it("should return ok when acpx is installed", async () => {
      const mockProc = createMockProc({ stdoutData: ["acpx version 0.1.15"], closeCode: 0 });
      vi.mocked(spawn).mockReturnValue(mockProc);

      const result = await backend.doctor();

      expect(result.ok).toBe(true);
      expect(result.message).toContain("0.1.15");
    });

    it("should return not installed when acpx is not available", async () => {
      const mockProc = createMockProc({ closeCode: 1 });
      vi.mocked(spawn).mockReturnValue(mockProc);

      const result = await backend.doctor();

      expect(result.ok).toBe(false);
      expect(result.code).toBe("ACPX_NOT_INSTALLED");
    });
  });

  describe("ensureSession", () => {
    it("should create a session and return handle with backendSessionId", async () => {
      const mockProc = createMockProc({
        stdoutData: ["session: test-123\n\n019cd105-aad7-7d50-88d6-0ed2ea913d8e"],
        closeCode: 0,
      });
      vi.mocked(spawn).mockReturnValue(mockProc);

      const handle = await backend.ensureSession({
        sessionKey: "test-session",
        agent: "test-agent",
        mode: "persistent",
      });

      expect(handle.backend).toBe("acpx");
      expect(handle.runtimeSessionName).toMatch(/^acpx-test-session-/);
      expect(handle.backendSessionId).toBe("019cd105-aad7-7d50-88d6-0ed2ea913d8e");
      expect(handle.agentSessionId).toBeUndefined(); // ACPX does not expose this
    });

    it("should throw on session creation failure", async () => {
      const mockProc = createMockProc({
        stderrData: ["Error: session creation failed"],
        closeCode: 1,
      });
      vi.mocked(spawn).mockReturnValue(mockProc);

      await expect(
        backend.ensureSession({
          sessionKey: "test-session",
          agent: "test-agent",
          mode: "persistent",
        }),
      ).rejects.toThrow("Failed to create ACPX session");
    });
  });

  describe("getStatus", () => {
    it("should parse status output correctly", async () => {
      const statusOutput = `session: 019cd105-aad7-7d50-88d6-0ed2ea913d8e
agent: npx @zed-industries/codex-acp
pid: 77440
status: running
uptime: 00:00:46
lastPromptTime: 2026-03-09T05:16:11.671Z`;

      const mockProc = createMockProc({ stdoutData: [statusOutput], closeCode: 0 });
      vi.mocked(spawn).mockReturnValue(mockProc);

      const status = await backend.getStatus({
        handle: {
          sessionKey: "test",
          backend: "acpx",
          runtimeSessionName: "test-session",
        },
      });

      expect(status.backendSessionId).toBe("019cd105-aad7-7d50-88d6-0ed2ea913d8e");
      expect(status.details?.["pid"]).toBe(77440);
      expect(status.details?.["status"]).toBe("running");
      expect(status.details?.["agent"]).toBe("npx @zed-industries/codex-acp");
      // agentSessionId should NOT be set - agent is command string, not unique ID
      expect(status.agentSessionId).toBeUndefined();
    });
  });

  describe("close", () => {
    it("should close session successfully", async () => {
      const mockProc = createMockProc({ closeCode: 0 });
      vi.mocked(spawn).mockReturnValue(mockProc);

      await expect(
        backend.close({
          handle: {
            sessionKey: "test",
            backend: "acpx",
            runtimeSessionName: "test-session",
          },
          reason: "user requested",
        }),
      ).resolves.not.toThrow();
    });

    it("should handle already closed gracefully", async () => {
      const mockProc = createMockProc({
        stderrData: ["Session not found or already closed"],
        closeCode: 1,
      });
      vi.mocked(spawn).mockReturnValue(mockProc);

      // Should not throw - already closed is acceptable
      await expect(
        backend.close({
          handle: {
            sessionKey: "test",
            backend: "acpx",
            runtimeSessionName: "test-session",
          },
          reason: "user requested",
        }),
      ).resolves.not.toThrow();
    });
  });

  describe("cancel", () => {
    it("should cancel session successfully", async () => {
      const mockProc = createMockProc({ closeCode: 0 });
      vi.mocked(spawn).mockReturnValue(mockProc);

      await expect(
        backend.cancel({
          handle: {
            sessionKey: "test",
            backend: "acpx",
            runtimeSessionName: "test-session",
          },
          reason: "user cancelled",
        }),
      ).resolves.not.toThrow();
    });
  });

  describe("runTurn", () => {
    it("should emit exactly one terminal error for stderr-heavy warmup failure", async () => {
      const mockProc = createMockProc();
      vi.mocked(spawn).mockReturnValue(mockProc);

      const iterator = backend.runTurn({
        handle: {
          sessionKey: "test",
          backend: "acpx",
          runtimeSessionName: "test-session",
        },
        text: "hello",
        mode: "prompt",
        requestId: "req-1",
      });
      const turn = iterator[Symbol.asyncIterator]();

      const first = await turn.next();
      expect(first.value?.type).toBe("started");

      const nextEventPromise = turn.next();
      mockProc.stderr!.emit("data", Buffer.from("[error] RUNTIME: Resource not found\n"));
      mockProc.stderr!.emit("data", Buffer.from("extra stderr\n"));
      mockProc.emit("close", 1);

      const second = await nextEventPromise;
      expect(second.value).toMatchObject({
        type: "error",
        code: "WARMUP_FAILURE",
        retryable: true,
      });

      const done = await turn.next();
      expect(done.done).toBe(true);
    });

    it("should emit done when process closes immediately", async () => {
      const mockProc = createMockProc();
      vi.mocked(spawn).mockReturnValue(mockProc);

      const iterator = backend.runTurn({
        handle: {
          sessionKey: "test",
          backend: "acpx",
          runtimeSessionName: "test-session",
        },
        text: "hello",
        mode: "prompt",
        requestId: "req-2",
      });
      const turn = iterator[Symbol.asyncIterator]();

      const first = await turn.next();
      expect(first.value?.type).toBe("started");

      const secondPromise = turn.next();
      const procWithStreams = mockProc as unknown as {
        stdout: { emit: (event: string, payload: Buffer) => void };
      };
      procWithStreams.stdout.emit("data", Buffer.from("hello world\n[done] end_turn\n"));
      mockProc.emit("close", 0);

      const second = await secondPromise;
      expect(second.value).toMatchObject({ type: "text_delta", text: "hello world\n" });

      const third = await turn.next();
      expect(third.value).toMatchObject({ type: "done", stopReason: "completed" });

      const done = await turn.next();
      expect(done.done).toBe(true);
    });
  });

  describe("getCapabilities", () => {
    it("should return correct controls", async () => {
      const caps = await backend.getCapabilities();

      expect(caps.controls).toContain("session/set_mode");
      expect(caps.controls).toContain("session/set_config_option");
      expect(caps.controls).toContain("session/status");
    });
  });
});
