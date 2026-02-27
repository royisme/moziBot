import { describe, it, expect, vi, beforeEach } from "vitest";
import { createExecTool } from "./exec-tool.js";
import type { ExecRuntime, ExecResult } from "./exec-runtime.js";

type TextItem = { type: "text"; text: string };

describe("createExecTool", () => {
  let mockRuntime: ExecRuntime;
  let mockExecute: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockExecute = vi.fn();
    mockRuntime = {
      execute: mockExecute,
    } as unknown as ExecRuntime;
  });

  it("should return a valid AgentTool", () => {
    const tool = createExecTool({
      runtime: mockRuntime,
      agentId: "agent-1",
      sessionKey: "session-1",
    });

    expect(tool).toHaveProperty("name", "exec");
    expect(tool).toHaveProperty("label", "Exec");
    expect(tool).toHaveProperty("description");
    expect(tool).toHaveProperty("parameters");
    expect(tool).toHaveProperty("execute");
    expect(typeof tool.execute).toBe("function");
  });

  it("should pass normalized args to runtime.execute", async () => {
    const tool = createExecTool({
      runtime: mockRuntime,
      agentId: "agent-1",
      sessionKey: "session-1",
    });

    mockExecute.mockResolvedValue({
      type: "completed",
      stdout: "hello",
      stderr: "",
      exitCode: 0,
    } as ExecResult);

    await tool.execute("tool-call-1", {
      command: "echo hello",
      cwd: "/test",
      env: { MY_VAR: "value" },
      authRefs: ["MY_KEY"],
      yieldMs: 5000,
      background: false,
      pty: true,
      timeoutSec: 60,
    });

    // normalizeArgs sets defaults for background and pty
    expect(mockExecute).toHaveBeenCalledWith({
      command: "echo hello",
      cwd: "/test",
      env: { MY_VAR: "value" },
      authRefs: ["MY_KEY"],
      yieldMs: 5000,
      background: false,
      pty: true,
      timeoutSec: 60,
      agentId: "agent-1",
      sessionKey: "session-1",
    });
  });

  it("should handle missing optional args gracefully", async () => {
    const tool = createExecTool({
      runtime: mockRuntime,
      agentId: "agent-1",
      sessionKey: "session-1",
    });

    mockExecute.mockResolvedValue({
      type: "completed",
      stdout: "hello",
      stderr: "",
      exitCode: 0,
    } as ExecResult);

    // Pass only command (no optional args)
    await tool.execute("tool-call-1", {
      command: "echo hello",
    });

    // Should have command + agentId + sessionKey, and normalize adds defaults for missing
    expect(mockExecute).toHaveBeenCalledWith({
      command: "echo hello",
      cwd: undefined,
      env: undefined,
      authRefs: undefined,
      yieldMs: undefined,
      background: false,
      pty: false,
      timeoutSec: undefined,
      agentId: "agent-1",
      sessionKey: "session-1",
    });
  });

  it("should handle invalid args gracefully", async () => {
    const tool = createExecTool({
      runtime: mockRuntime,
      agentId: "agent-1",
      sessionKey: "session-1",
    });

    mockExecute.mockResolvedValue({
      type: "completed",
      stdout: "",
      stderr: "",
      exitCode: 0,
    } as ExecResult);

    // Pass invalid/missing args
    await tool.execute("tool-call-1", {
      command: 123 as any, // invalid - should be string
      cwd: null as any, // invalid
      env: "not an object" as any, // invalid
      authRefs: [1, 2, 3] as any, // invalid - becomes empty array after filter
    });

    // Should default to empty command, and default booleans to false
    // authRefs becomes [] because invalid values are filtered out
    expect(mockExecute).toHaveBeenCalledWith({
      command: "",
      cwd: undefined,
      env: undefined,
      authRefs: [],
      yieldMs: undefined,
      background: false,
      pty: false,
      timeoutSec: undefined,
      agentId: "agent-1",
      sessionKey: "session-1",
    });
  });
});

describe("formatResult", () => {
  let mockRuntime: ExecRuntime;

  beforeEach(() => {
    mockRuntime = {
      execute: vi.fn(),
    } as unknown as ExecRuntime;
  });

  it("should format completed result", async () => {
    const tool = createExecTool({
      runtime: mockRuntime,
      agentId: "agent-1",
      sessionKey: "session-1",
    });

    const completedResult: ExecResult = {
      type: "completed",
      stdout: "hello world",
      stderr: "error output",
      exitCode: 0,
    };

    (mockRuntime.execute as ReturnType<typeof vi.fn>).mockResolvedValue(completedResult);

    const output = await tool.execute("tool-call-1", { command: "echo hello" });

    expect(output.content).toHaveLength(1);
    expect(output.content[0].type).toBe("text");
    expect((output.content[0] as TextItem).text).toContain("exitCode: 0");
    expect((output.content[0] as TextItem).text).toContain("stdout:\nhello world");
    expect((output.content[0] as TextItem).text).toContain("stderr:\nerror output");
    expect(output.details).toEqual({ exitCode: 0 });
  });

  it("should format completed result with empty stdout/stderr", async () => {
    const tool = createExecTool({
      runtime: mockRuntime,
      agentId: "agent-1",
      sessionKey: "session-1",
    });

    const completedResult: ExecResult = {
      type: "completed",
      stdout: "",
      stderr: "",
      exitCode: 0,
    };

    (mockRuntime.execute as ReturnType<typeof vi.fn>).mockResolvedValue(completedResult);

    const output = await tool.execute("tool-call-1", { command: "true" });

    // Should show "stdout:" and "stderr:" but not with newlines after them
    expect((output.content[0] as TextItem).text).toContain("stdout:");
    expect((output.content[0] as TextItem).text).toContain("stderr:");
    // When empty, there shouldn't be a newline after the label
    const lines = (output.content[0] as TextItem).text.split("\n");
    const stdoutLine = lines.find((l: string) => l.startsWith("stdout:"));
    const stderrLine = lines.find((l: string) => l.startsWith("stderr:"));
    // If stdout/stderr is empty, the line should just be "stdout:" or "stdout:\n"
    // and should not be followed by more content on the next line as part of that value
    expect(stdoutLine).toBe("stdout:");
    expect(stderrLine).toBe("stderr:");
  });

  it("should format backgrounded result", async () => {
    const tool = createExecTool({
      runtime: mockRuntime,
      agentId: "agent-1",
      sessionKey: "session-1",
    });

    const backgroundedResult: ExecResult = {
      type: "backgrounded",
      jobId: "job_123_abc",
      pid: 12345,
      message: "Process started in background",
    };

    (mockRuntime.execute as ReturnType<typeof vi.fn>).mockResolvedValue(backgroundedResult);

    const output = await tool.execute("tool-call-1", { command: "sleep 100", background: true });

    expect(output.content).toHaveLength(1);
    expect(output.content[0].type).toBe("text");
    expect((output.content[0] as TextItem).text).toContain("Process started in background");
    expect((output.content[0] as TextItem).text).toContain("job_123_abc");
    expect(output.details).toEqual({
      jobId: "job_123_abc",
      pid: 12345,
      backgrounded: true,
    });
  });

  it("should format yielded result", async () => {
    const tool = createExecTool({
      runtime: mockRuntime,
      agentId: "agent-1",
      sessionKey: "session-1",
    });

    const yieldedResult: ExecResult = {
      type: "yielded",
      jobId: "job_456_def",
      pid: 67890,
      output: "initial output here",
      message: "Process still running after 10000ms",
    };

    (mockRuntime.execute as ReturnType<typeof vi.fn>).mockResolvedValue(yieldedResult);

    const output = await tool.execute("tool-call-1", { command: "sleep 100", yieldMs: 10000 });

    expect(output.content).toHaveLength(1);
    expect(output.content[0].type).toBe("text");
    expect((output.content[0] as TextItem).text).toContain("Process still running after 10000ms");
    expect((output.content[0] as TextItem).text).toContain("Initial output:");
    expect((output.content[0] as TextItem).text).toContain("initial output here");
    expect(output.details).toEqual({
      jobId: "job_456_def",
      pid: 67890,
      backgrounded: true,
    });
  });

  it("should format error result", async () => {
    const tool = createExecTool({
      runtime: mockRuntime,
      agentId: "agent-1",
      sessionKey: "session-1",
    });

    const errorResult: ExecResult = {
      type: "error",
      message: "command not allowed: cat",
    };

    (mockRuntime.execute as ReturnType<typeof vi.fn>).mockResolvedValue(errorResult);

    const output = await tool.execute("tool-call-1", { command: "cat /etc/passwd" });

    expect(output.content).toHaveLength(1);
    expect(output.content[0].type).toBe("text");
    expect((output.content[0] as TextItem).text).toBe("command not allowed: cat");
    expect(output.details).toEqual({ error: true });
  });
});
