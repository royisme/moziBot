import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ExecRuntime, type ExecRequest, type ExecResult } from "./exec-runtime.js";
import { ProcessSupervisor } from "../process/supervisor.js";
import { ProcessRegistry } from "../process/process-registry.js";
import type { SandboxBoundary } from "./sandbox/config.js";
import type { VibeboxExecutor } from "./sandbox/vibebox-executor.js";

describe("ExecRuntime", () => {
  let runtime: ExecRuntime;
  let mockSupervisor: ProcessSupervisor;
  let mockRegistry: ProcessRegistry;
  let boundary: SandboxBoundary;

  beforeEach(() => {
    // Create a test registry with in-memory SQLite
    const testDbPath = ":memory:";
    mockRegistry = new ProcessRegistry(testDbPath);

    // Create mock supervisor
    mockSupervisor = {
      start: vi.fn(),
      get: vi.fn(),
      kill: vi.fn(),
      tail: vi.fn(),
    } as unknown as ProcessSupervisor;

    boundary = {
      workspaceDir: "/test/workspace",
      allowlist: ["ls", "cat", "echo", "grep", "sh", "bash"],
      blockedEnvKeys: ["PATH", "LD_PRELOAD"],
      mode: "off",
    };

    // Create ExecRuntime instance
    runtime = new ExecRuntime(
      mockSupervisor,
      mockRegistry,
      boundary,
      undefined, // no auth resolver
      ["MY_API_KEY"], // allowed secrets
    );
  });

  afterEach(() => {
    mockRegistry.close();
    vi.clearAllMocks();
  });

  describe("execute (one-shot)", () => {
    it("should execute a simple command and capture stdout", async () => {
      const mockHandle = {
        id: "job_test123",
        pid: 12345,
        kill: vi.fn(),
        onOutput: vi.fn(),
        getOutput: () => "hello\n",
        promise: Promise.resolve({
          type: "exited" as const,
          exitCode: 0,
          reason: "exit" as const,
          stdout: "hello\n",
          stderr: "",
        }),
      };

      mockSupervisor.start = vi.fn().mockReturnValue(mockHandle);

      const result = await runtime.execute({
        command: "echo hello",
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
      const mockHandle = {
        id: "job_test123",
        pid: 12345,
        kill: vi.fn(),
        onOutput: vi.fn(),
        getOutput: () => "",
        promise: Promise.resolve({
          type: "exited" as const,
          exitCode: 1,
          reason: "exit" as const,
          stdout: "",
          stderr: "command failed",
        }),
      };

      mockSupervisor.start = vi.fn().mockReturnValue(mockHandle);

      // Use a command that exits with code 1 - "sh -c 'exit 1'" is not in allowlist,
      // so use a command that IS in allowlist but will fail
      const result = await runtime.execute({
        command: "bash -c 'exit 1'",
        agentId: "agent-1",
        sessionKey: "session-1",
      });

      expect(result).toEqual({
        type: "completed",
        stdout: "",
        stderr: "command failed",
        exitCode: 1,
      });
    });
  });

  describe("command validation", () => {
    it("should reject commands not in allowlist", async () => {
      const restrictedBoundary: SandboxBoundary = {
        ...boundary,
        allowlist: ["ls", "echo"], // very restrictive
      };

      const restrictedRuntime = new ExecRuntime(
        mockSupervisor,
        mockRegistry,
        restrictedBoundary,
      );

      const result = await restrictedRuntime.execute({
        command: "cat /etc/passwd",
        agentId: "agent-1",
        sessionKey: "session-1",
      });

      expect(result).toEqual({
        type: "error",
        message: "command not allowed: cat",
      });
    });

    it("should allow commands in allowlist", async () => {
      const mockHandle = {
        id: "job_test123",
        pid: 12345,
        kill: vi.fn(),
        onOutput: vi.fn(),
        getOutput: () => "",
        promise: Promise.resolve({
          type: "exited" as const,
          exitCode: 0,
          reason: "exit" as const,
          stdout: "",
          stderr: "",
        }),
      };

      mockSupervisor.start = vi.fn().mockReturnValue(mockHandle);

      const result = await runtime.execute({
        command: "ls -la",
        agentId: "agent-1",
        sessionKey: "session-1",
      });

      expect(result.type).toBe("completed");
    });
  });

  describe("cwd validation", () => {
    it("should reject cwd outside workspace", async () => {
      const result = await runtime.execute({
        command: "echo hello",
        cwd: "/etc", // outside workspace
        agentId: "agent-1",
        sessionKey: "session-1",
      });

      expect(result).toEqual({
        type: "error",
        message: "cwd must be within workspace",
      });
    });

    it("should accept cwd within workspace", async () => {
      const mockHandle = {
        id: "job_test123",
        pid: 12345,
        kill: vi.fn(),
        onOutput: vi.fn(),
        getOutput: () => "",
        promise: Promise.resolve({
          type: "exited" as const,
          exitCode: 0,
          reason: "exit" as const,
          stdout: "",
          stderr: "",
        }),
      };

      mockSupervisor.start = vi.fn().mockReturnValue(mockHandle);

      const result = await runtime.execute({
        command: "echo hello",
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
        command: "echo hello",
        env: {
          MY_API_KEY: "secret", // This should be blocked
        },
        agentId: "agent-1",
        sessionKey: "session-1",
      });

      expect(result).toEqual({
        type: "error",
        message: "Protected auth env vars not allowed: MY_API_KEY. Use authRefs.",
      });
    });

    it("should allow non-protected env vars", async () => {
      const mockHandle = {
        id: "job_test123",
        pid: 12345,
        kill: vi.fn(),
        onOutput: vi.fn(),
        getOutput: () => "",
        promise: Promise.resolve({
          type: "exited" as const,
          exitCode: 0,
          reason: "exit" as const,
          stdout: "",
          stderr: "",
        }),
      };

      mockSupervisor.start = vi.fn().mockReturnValue(mockHandle);

      const result = await runtime.execute({
        command: "echo hello",
        env: {
          MY_VAR: "value", // Not a protected pattern
        },
        agentId: "agent-1",
        sessionKey: "session-1",
      });

      expect(result.type).toBe("completed");
    });
  });

  describe("auth resolution", () => {
    it("should reject when authResolver is missing but authRefs provided", async () => {
      const runtimeWithoutAuth = new ExecRuntime(
        mockSupervisor,
        mockRegistry,
        boundary,
        undefined, // no auth resolver
        [],
      );

      const result = await runtimeWithoutAuth.execute({
        command: "echo hello",
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
      const mockAuthResolver = {
        getValue: vi.fn().mockResolvedValue("secret-value"),
      };

      const runtimeWithAuth = new ExecRuntime(
        mockSupervisor,
        mockRegistry,
        boundary,
        mockAuthResolver as any,
        ["ALLOWED_KEY"], // only ALLOWED_KEY is allowed
      );

      const result = await runtimeWithAuth.execute({
        command: "echo hello",
        authRefs: ["DENIED_KEY"], // DENIED_KEY is not in allowed list
        agentId: "agent-1",
        sessionKey: "session-1",
      });

      expect(result).toEqual({
        type: "error",
        message: "Secret(s) not allowed: DENIED_KEY",
      });
    });

    it("should resolve allowed auth refs", async () => {
      const mockAuthResolver = {
        getValue: vi.fn().mockResolvedValue("secret-value"),
      };

      const runtimeWithAuth = new ExecRuntime(
        mockSupervisor,
        mockRegistry,
        boundary,
        mockAuthResolver as any,
        ["MY_API_KEY"],
      );

      const mockHandle = {
        id: "job_test123",
        pid: 12345,
        kill: vi.fn(),
        onOutput: vi.fn(),
        getOutput: () => "",
        promise: Promise.resolve({
          type: "exited" as const,
          exitCode: 0,
          reason: "exit" as const,
          stdout: "",
          stderr: "",
        }),
      };

      mockSupervisor.start = vi.fn().mockReturnValue(mockHandle);

      const result = await runtimeWithAuth.execute({
        command: "echo hello",
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
      const mockAuthResolver = {
        getValue: vi.fn().mockResolvedValue(null), // missing
      };

      const runtimeWithAuth = new ExecRuntime(
        mockSupervisor,
        mockRegistry,
        boundary,
        mockAuthResolver as any,
        ["MY_API_KEY"],
      );

      const result = await runtimeWithAuth.execute({
        command: "echo hello",
        authRefs: ["MY_API_KEY"],
        agentId: "agent-1",
        sessionKey: "session-1",
      });

      expect(result).toEqual({
        type: "error",
        message: "AUTH_MISSING MY_API_KEY",
      });
    });
  });

  describe("background execution", () => {
    it("should return immediately with jobId for background execution", async () => {
      const mockHandle = {
        id: "job_test123",
        pid: 12345,
        kill: vi.fn(),
        onOutput: vi.fn(),
        getOutput: () => "",
        promise: new Promise(() => {}), // never resolves
      };

      mockSupervisor.start = vi.fn().mockReturnValue(mockHandle);

      // Use a command in the allowlist
      const result = await runtime.execute({
        command: "bash -c 'while true; do sleep 1; done'",
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
      const mockHandle = {
        id: "job_test123",
        pid: 12345,
        kill: vi.fn(),
        onOutput: vi.fn(),
        getOutput: () => "initial output",
        promise: new Promise(() => {}), // never resolves - process keeps running
      };

      mockSupervisor.start = vi.fn().mockReturnValue(mockHandle);

      // Use a very short yield time for testing, with a command in allowlist
      const result = await runtime.execute({
        command: "bash -c 'while true; do sleep 1; done'",
        yieldMs: 10, // 10ms for fast test
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

    beforeEach(() => {
      vibeboxBoundary = {
        workspaceDir: "/test/workspace",
        allowlist: ["echo", "ls"],
        blockedEnvKeys: ["PATH"],
        mode: "vibebox",
      };
      mockVibeboxExecutor = {
        exec: vi.fn(),
        probe: vi.fn(),
        stop: vi.fn(),
      } as unknown as VibeboxExecutor;
    });

    it("should delegate one-shot execution to VibeboxExecutor", async () => {
      (mockVibeboxExecutor.exec as ReturnType<typeof vi.fn>).mockResolvedValue({
        stdout: "vibebox output",
        stderr: "",
        exitCode: 0,
      });

      const vibeboxRuntime = new ExecRuntime(
        mockSupervisor,
        mockRegistry,
        vibeboxBoundary,
        undefined,
        [],
        mockVibeboxExecutor,
      );

      const result = await vibeboxRuntime.execute({
        command: "echo hello",
        agentId: "agent-1",
        sessionKey: "session-1",
      });

      expect(result).toEqual({
        type: "completed",
        stdout: "vibebox output",
        stderr: "",
        exitCode: 0,
      });
      expect(mockVibeboxExecutor.exec).toHaveBeenCalledWith({
        sessionKey: "session-1",
        agentId: "agent-1",
        workspaceDir: "/test/workspace",
        command: "echo hello",
        cwd: "/test/workspace",
        env: expect.any(Object),
      });
    });

    it("should return error when VibeboxExecutor throws", async () => {
      (mockVibeboxExecutor.exec as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error("vibebox bridge failed"),
      );

      const vibeboxRuntime = new ExecRuntime(
        mockSupervisor,
        mockRegistry,
        vibeboxBoundary,
        undefined,
        [],
        mockVibeboxExecutor,
      );

      const result = await vibeboxRuntime.execute({
        command: "echo hello",
        agentId: "agent-1",
        sessionKey: "session-1",
      });

      expect(result).toEqual({
        type: "error",
        message: "vibebox bridge failed",
      });
    });

    it("should return error for background execution in vibebox mode", async () => {
      const vibeboxRuntime = new ExecRuntime(
        mockSupervisor,
        mockRegistry,
        vibeboxBoundary,
        undefined,
        [],
        mockVibeboxExecutor,
      );

      const result = await vibeboxRuntime.execute({
        command: "echo hello",
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
        mockSupervisor,
        mockRegistry,
        vibeboxBoundary,
        undefined,
        [],
        mockVibeboxExecutor,
      );

      const result = await vibeboxRuntime.execute({
        command: "echo hello",
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
      const vibeboxRuntime = new ExecRuntime(
        mockSupervisor,
        mockRegistry,
        vibeboxBoundary,
        undefined,
        [],
        // no vibeboxExecutor
      );

      const result = await vibeboxRuntime.execute({
        command: "echo hello",
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
        mockSupervisor,
        mockRegistry,
        vibeboxBoundary,
        undefined,
        [],
        mockVibeboxExecutor,
      );

      const result = await vibeboxRuntime.execute({
        command: "cat /etc/passwd", // 'cat' not in allowlist
        agentId: "agent-1",
        sessionKey: "session-1",
      });

      expect(result).toEqual({
        type: "error",
        message: "command not allowed: cat",
      });
      expect(mockVibeboxExecutor.exec).not.toHaveBeenCalled();
    });

    it("should pass non-zero exit code from vibebox through", async () => {
      (mockVibeboxExecutor.exec as ReturnType<typeof vi.fn>).mockResolvedValue({
        stdout: "",
        stderr: "command not found",
        exitCode: 127,
      });

      const vibeboxRuntime = new ExecRuntime(
        mockSupervisor,
        mockRegistry,
        vibeboxBoundary,
        undefined,
        [],
        mockVibeboxExecutor,
      );

      const result = await vibeboxRuntime.execute({
        command: "echo hello",
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
