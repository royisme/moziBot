import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ProcessRegistry } from "../process/process-registry.js";
import { setProcessSupervisor, resetProcessSupervisor } from "../process/supervisor/index.js";
import type { ProcessSupervisor, ManagedRun, RunExit } from "../process/supervisor/index.js";
import { ExecRuntime } from "./exec-runtime.js";
import type { AuthResolver } from "./exec-runtime.js";
import type { SandboxBoundary } from "./sandbox/config.js";
import type { VibeboxExecutor } from "./sandbox/vibebox-executor.js";

// Helper: create a mock ManagedRun that resolves with given exit
function mockManagedRun(exit: RunExit, pid = 12345): ManagedRun {
  return {
    runId: "job_test123",
    pid,
    startedAtMs: Date.now(),
    stdin: undefined,
    wait: () => Promise.resolve(exit),
    cancel: vi.fn(),
  };
}

const defaultExit: RunExit = {
  reason: "exit",
  exitCode: 0,
  exitSignal: null,
  durationMs: 10,
  stdout: "",
  stderr: "",
  timedOut: false,
  noOutputTimedOut: false,
};

describe("ExecRuntime", () => {
  let runtime: ExecRuntime;
  let mockSupervisor: ProcessSupervisor;
  let mockRegistry: ProcessRegistry;
  let boundary: SandboxBoundary;

  beforeEach(() => {
    // Create a test registry with in-memory SQLite
    mockRegistry = new ProcessRegistry(":memory:");

    // Create mock supervisor
    mockSupervisor = {
      spawn: vi.fn().mockResolvedValue(mockManagedRun(defaultExit)),
      cancel: vi.fn(),
      cancelScope: vi.fn(),
      getRecord: vi.fn().mockReturnValue(undefined),
    } as unknown as ProcessSupervisor;

    // Inject mock supervisor globally
    setProcessSupervisor(mockSupervisor);

    boundary = {
      workspaceDir: "/test/workspace",
      allowlist: ["ls", "cat", "echo", "grep", "sh", "bash"],
      blockedEnvKeys: ["PATH", "LD_PRELOAD"],
      mode: "off",
    };

    runtime = new ExecRuntime(
      mockRegistry,
      boundary,
      undefined, // no auth resolver
      ["MY_API_KEY"], // allowed secrets
    );
  });

  afterEach(() => {
    mockRegistry.close();
    resetProcessSupervisor();
    vi.clearAllMocks();
  });

  describe("execute (one-shot)", () => {
    it("should execute a simple command and capture stdout", async () => {
      let stdoutCb: ((chunk: string) => void) | undefined;
      mockSupervisor.spawn = vi
        .fn()
        .mockImplementation(async (input: { onStdout?: (c: string) => void }) => {
          stdoutCb = input.onStdout;
          stdoutCb?.("hello\n");
          return mockManagedRun({ ...defaultExit, exitCode: 0 });
        });

      const result = await runtime.execute({
        argv: ["echo", "hello"],
        agentId: "agent-1",
        sessionKey: "session-1",
      });

      expect(result).toEqual({
        type: "completed",
        stdout: "hello\n",
        stderr: "",
        exitCode: 0,
      });
    });

    it("should capture non-zero exit code", async () => {
      mockSupervisor.spawn = vi
        .fn()
        .mockResolvedValue(mockManagedRun({ ...defaultExit, exitCode: 1 }));

      const result = await runtime.execute({
        argv: ["bash", "-c", "exit 1"],
        agentId: "agent-1",
        sessionKey: "session-1",
      });

      expect(result).toEqual({
        type: "completed",
        stdout: "",
        stderr: "",
        exitCode: 1,
      });
    });
  });

  describe("command validation", () => {
    it("should reject commands not in allowlist", async () => {
      const restrictedBoundary: SandboxBoundary = {
        ...boundary,
        allowlist: ["ls", "echo"],
      };

      const restrictedRuntime = new ExecRuntime(mockRegistry, restrictedBoundary);

      const result = await restrictedRuntime.execute({
        argv: ["cat", "/etc/passwd"],
        agentId: "agent-1",
        sessionKey: "session-1",
      });

      expect(result).toEqual({
        type: "error",
        message: "command not allowed: cat",
      });
    });

    it("should allow commands in allowlist", async () => {
      const result = await runtime.execute({
        argv: ["ls", "-la"],
        agentId: "agent-1",
        sessionKey: "session-1",
      });

      expect(result.type).toBe("completed");
    });
  });

  describe("cwd validation", () => {
    it("should reject cwd outside workspace", async () => {
      const result = await runtime.execute({
        argv: ["echo", "hello"],
        cwd: "/etc",
        agentId: "agent-1",
        sessionKey: "session-1",
      });

      expect(result).toEqual({
        type: "error",
        message: "cwd must be within workspace",
      });
    });

    it("should accept cwd within workspace", async () => {
      const result = await runtime.execute({
        argv: ["echo", "hello"],
        cwd: "/test/workspace/subdir",
        agentId: "agent-1",
        sessionKey: "session-1",
      });

      expect(result.type).toBe("completed");
    });
  });

  describe("protected env vars", () => {
    it("should reject protected auth env vars in env", async () => {
      const result = await runtime.execute({
        argv: ["echo", "hello"],
        env: { MY_API_KEY: "secret" },
        agentId: "agent-1",
        sessionKey: "session-1",
      });

      expect(result).toEqual({
        type: "error",
        message: "Protected auth env vars not allowed: MY_API_KEY. Use authRefs.",
      });
    });

    it("should allow non-protected env vars", async () => {
      const result = await runtime.execute({
        argv: ["echo", "hello"],
        env: { MY_VAR: "value" },
        agentId: "agent-1",
        sessionKey: "session-1",
      });

      expect(result.type).toBe("completed");
    });
  });

  describe("auth resolution", () => {
    it("should reject when authResolver is missing but authRefs provided", async () => {
      const runtimeWithoutAuth = new ExecRuntime(mockRegistry, boundary, undefined, []);

      const result = await runtimeWithoutAuth.execute({
        argv: ["echo", "hello"],
        authRefs: ["MY_API_KEY"],
        agentId: "agent-1",
        sessionKey: "session-1",
      });

      expect(result).toEqual({
        type: "error",
        message: "Auth broker is disabled for this runtime.",
      });
    });

    it("should reject secrets not in allowed list", async () => {
      const runtimeWithAuth = new ExecRuntime(
        mockRegistry,
        boundary,
        { getValue: vi.fn().mockResolvedValue("secret-value") } as AuthResolver,
        ["ALLOWED_KEY"],
      );

      const result = await runtimeWithAuth.execute({
        argv: ["echo", "hello"],
        authRefs: ["DENIED_KEY"],
        agentId: "agent-1",
        sessionKey: "session-1",
      });

      expect(result).toEqual({
        type: "error",
        message: "Secret(s) not allowed: DENIED_KEY",
      });
    });

    it("should resolve allowed auth refs", async () => {
      const mockAuthResolver = { getValue: vi.fn().mockResolvedValue("secret-value") };
      const runtimeWithAuth = new ExecRuntime(
        mockRegistry,
        boundary,
        mockAuthResolver as AuthResolver,
        ["MY_API_KEY"],
      );

      const result = await runtimeWithAuth.execute({
        argv: ["echo", "hello"],
        authRefs: ["MY_API_KEY"],
        agentId: "agent-1",
        sessionKey: "session-1",
      });

      expect(mockAuthResolver.getValue).toHaveBeenCalledWith({
        name: "MY_API_KEY",
        agentId: "agent-1",
      });
      expect(result.type).toBe("completed");
    });

    it("should return error for missing auth value", async () => {
      const runtimeWithAuth = new ExecRuntime(
        mockRegistry,
        boundary,
        { getValue: vi.fn().mockResolvedValue(null) } as AuthResolver,
        ["MY_API_KEY"],
      );

      const result = await runtimeWithAuth.execute({
        argv: ["echo", "hello"],
        authRefs: ["MY_API_KEY"],
        agentId: "agent-1",
        sessionKey: "session-1",
      });

      expect(result).toEqual({ type: "error", message: "AUTH_MISSING MY_API_KEY" });
    });
  });

  describe("background execution", () => {
    it("should return immediately with jobId for background execution", async () => {
      let neverResolve: ManagedRun;
      mockSupervisor.spawn = vi.fn().mockImplementation(async () => {
        neverResolve = {
          runId: "job_test123",
          pid: 12345,
          startedAtMs: Date.now(),
          wait: () => new Promise(() => {}), // never resolves
          cancel: vi.fn(),
        };
        return neverResolve;
      });

      const result = await runtime.execute({
        argv: ["bash", "-c", "while true; do sleep 1; done"],
        background: true,
        agentId: "agent-1",
        sessionKey: "session-1",
      });

      expect(result).toEqual({
        type: "backgrounded",
        jobId: expect.stringMatching(/^job_\d+_/),
        pid: 12345,
        message: expect.stringMatching(/Process started in background/),
      });
    });
  });

  describe("yieldMs execution", () => {
    it("should yield after specified time", async () => {
      mockSupervisor.spawn = vi.fn().mockImplementation(async () => ({
        runId: "job_test123",
        pid: 12345,
        startedAtMs: Date.now(),
        wait: () => new Promise(() => {}), // never resolves
        cancel: vi.fn(),
      }));

      const result = await runtime.execute({
        argv: ["bash", "-c", "while true; do sleep 1; done"],
        yieldMs: 10,
        agentId: "agent-1",
        sessionKey: "session-1",
      });

      expect(result.type).toBe("yielded");
      if (result.type === "yielded") {
        expect(result.jobId).toMatch(/^job_\d+_/);
        expect(result.pid).toBe(12345);
        expect(result.message).toContain("still running after");
      }
    });
  });

  describe("vibebox execution", () => {
    let vibeboxBoundary: SandboxBoundary;
    let mockVibeboxExecutor: VibeboxExecutor;
    let mockVibeboxExec: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      vibeboxBoundary = {
        workspaceDir: "/test/workspace",
        allowlist: ["echo", "ls"],
        blockedEnvKeys: ["PATH"],
        mode: "vibebox",
      };
      mockVibeboxExec = vi.fn();
      mockVibeboxExecutor = {
        exec: mockVibeboxExec,
        probe: vi.fn(),
        stop: vi.fn(),
      } as unknown as VibeboxExecutor;
    });

    it("should delegate one-shot execution to VibeboxExecutor", async () => {
      mockVibeboxExec.mockResolvedValue({
        stdout: "vibebox output",
        stderr: "",
        exitCode: 0,
      });

      const vibeboxRuntime = new ExecRuntime(
        mockRegistry,
        vibeboxBoundary,
        undefined,
        [],
        mockVibeboxExecutor,
      );

      const result = await vibeboxRuntime.execute({
        argv: ["echo", "hello"],
        agentId: "agent-1",
        sessionKey: "session-1",
      });

      expect(result).toEqual({
        type: "completed",
        stdout: "vibebox output",
        stderr: "",
        exitCode: 0,
      });
      expect(mockVibeboxExec).toHaveBeenCalledWith({
        sessionKey: "session-1",
        agentId: "agent-1",
        workspaceDir: "/test/workspace",
        command: "echo hello",
        cwd: "/test/workspace",
        env: expect.any(Object),
      });
    });

    it("should return error when VibeboxExecutor throws", async () => {
      mockVibeboxExec.mockRejectedValue(new Error("vibebox bridge failed"));

      const vibeboxRuntime = new ExecRuntime(
        mockRegistry,
        vibeboxBoundary,
        undefined,
        [],
        mockVibeboxExecutor,
      );
      const result = await vibeboxRuntime.execute({
        argv: ["echo", "hello"],
        agentId: "agent-1",
        sessionKey: "session-1",
      });

      expect(result).toEqual({ type: "error", message: "vibebox bridge failed" });
    });

    it("should return error for background execution in vibebox mode", async () => {
      const vibeboxRuntime = new ExecRuntime(
        mockRegistry,
        vibeboxBoundary,
        undefined,
        [],
        mockVibeboxExecutor,
      );
      const result = await vibeboxRuntime.execute({
        argv: ["echo", "hello"],
        background: true,
        agentId: "agent-1",
        sessionKey: "session-1",
      });

      expect(result).toEqual({
        type: "error",
        message: "Background and yield execution modes are not supported in vibebox sandbox mode.",
      });
    });

    it("should return error for yieldMs execution in vibebox mode", async () => {
      const vibeboxRuntime = new ExecRuntime(
        mockRegistry,
        vibeboxBoundary,
        undefined,
        [],
        mockVibeboxExecutor,
      );
      const result = await vibeboxRuntime.execute({
        argv: ["echo", "hello"],
        yieldMs: 5000,
        agentId: "agent-1",
        sessionKey: "session-1",
      });

      expect(result).toEqual({
        type: "error",
        message: "Background and yield execution modes are not supported in vibebox sandbox mode.",
      });
    });

    it("should return error when vibebox mode is set but no VibeboxExecutor is injected", async () => {
      const vibeboxRuntime = new ExecRuntime(mockRegistry, vibeboxBoundary);
      const result = await vibeboxRuntime.execute({
        argv: ["echo", "hello"],
        agentId: "agent-1",
        sessionKey: "session-1",
      });

      expect(result).toEqual({
        type: "error",
        message: "Vibebox mode requires a VibeboxExecutor instance.",
      });
    });

    it("should still validate allowlist before delegating to vibebox", async () => {
      const vibeboxRuntime = new ExecRuntime(
        mockRegistry,
        vibeboxBoundary,
        undefined,
        [],
        mockVibeboxExecutor,
      );
      const result = await vibeboxRuntime.execute({
        argv: ["cat", "/etc/passwd"],
        agentId: "agent-1",
        sessionKey: "session-1",
      });

      expect(result).toEqual({ type: "error", message: "command not allowed: cat" });
      expect(mockVibeboxExec).not.toHaveBeenCalled();
    });

    it("should pass non-zero exit code from vibebox through", async () => {
      mockVibeboxExec.mockResolvedValue({ stdout: "", stderr: "command not found", exitCode: 127 });

      const vibeboxRuntime = new ExecRuntime(
        mockRegistry,
        vibeboxBoundary,
        undefined,
        [],
        mockVibeboxExecutor,
      );
      const result = await vibeboxRuntime.execute({
        argv: ["echo", "hello"],
        agentId: "agent-1",
        sessionKey: "session-1",
      });

      expect(result).toEqual({
        type: "completed",
        stdout: "",
        stderr: "command not found",
        exitCode: 127,
      });
    });
  });
});
