import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getProcessRegistry, closeProcessRegistry, resetProcessSupervisor } from "./index";
import { createProcessTool } from "./process-tool";

function text(
  result: Awaited<ReturnType<ReturnType<typeof createProcessTool>["execute"]>>,
  idx = 0,
): string {
  const item = result.content[idx] as { text?: string };
  return item.text ?? "";
}

describe("createProcessTool", () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mozi-process-tool-test-"));
    dbPath = path.join(tempDir, "test-registry.db");

    closeProcessRegistry();
    resetProcessSupervisor();
    getProcessRegistry(dbPath);
  });

  afterEach(() => {
    closeProcessRegistry();
    resetProcessSupervisor();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("should list processes when no jobId provided", async () => {
    const tool = createProcessTool({
      sessionKey: "test-session",
      agentId: "test-agent",
    });

    const registry = getProcessRegistry(dbPath);
    registry.addSession({
      id: "test-job-1",
      sessionId: "test-session",
      agentId: "test-agent",
      command: "sleep 100",
      cwd: tempDir,
      backgrounded: true,
      pty: false,
    });

    const result = await tool.execute("call-1", { action: "list" });

    expect(result.content[0].type).toBe("text");
    expect(text(result)).toContain("test-job-1");
  });

  it("should return status for a registered process", async () => {
    const tool = createProcessTool({
      sessionKey: "test-session",
      agentId: "test-agent",
    });

    const registry = getProcessRegistry(dbPath);
    registry.addSession({
      id: "test-job-2",
      sessionId: "test-session",
      agentId: "test-agent",
      command: "sleep 100",
      cwd: tempDir,
      backgrounded: true,
      pty: false,
    });

    const result = await tool.execute("call-1", { action: "status", jobId: "test-job-2" });

    expect(text(result)).toContain("test-job-2");
    expect(text(result)).toContain("running");
  });

  it("should return not found for non-existent process", async () => {
    const tool = createProcessTool({
      sessionKey: "test-session",
      agentId: "test-agent",
    });

    const result = await tool.execute("call-1", { action: "status", jobId: "non-existent" });

    expect(text(result)).toContain("Process not found");
  });

  it("should tail output from a completed process", async () => {
    const tool = createProcessTool({
      sessionKey: "test-session",
      agentId: "test-agent",
    });

    const registry = getProcessRegistry(dbPath);
    registry.addSession({
      id: "test-job-3",
      sessionId: "test-session",
      agentId: "test-agent",
      command: "echo test-output-line",
      cwd: tempDir,
      backgrounded: false,
      pty: false,
    });

    registry.appendOutput("test-job-3", "test-output-line\n");
    registry.markExited({ id: "test-job-3", exitCode: 0, signal: null });

    const result = await tool.execute("call-1", { action: "tail", jobId: "test-job-3" });

    expect(text(result)).toContain("test-output-line");
  });

  it("should tail with max chars limit", async () => {
    const tool = createProcessTool({
      sessionKey: "test-session",
      agentId: "test-agent",
    });

    const registry = getProcessRegistry(dbPath);
    registry.addSession({
      id: "test-job-4",
      sessionId: "test-session",
      agentId: "test-agent",
      command: "echo 'long output'",
      cwd: tempDir,
      backgrounded: false,
      pty: false,
    });

    const longOutput = "x".repeat(100);
    registry.appendOutput("test-job-4", longOutput);
    registry.markExited({ id: "test-job-4", exitCode: 0, signal: null });

    const result = await tool.execute("call-1", { action: "tail", jobId: "test-job-4", chars: 10 });

    expect(text(result)).toBeDefined();
  });

  it("should fail to kill a non-running process", async () => {
    const tool = createProcessTool({
      sessionKey: "test-session",
      agentId: "test-agent",
    });

    const registry = getProcessRegistry(dbPath);
    registry.addSession({
      id: "test-job-6",
      sessionId: "test-session",
      agentId: "test-agent",
      command: "echo quick",
      cwd: tempDir,
      backgrounded: false,
      pty: false,
    });
    registry.markExited({ id: "test-job-6", exitCode: 0, signal: null });

    const killResult = await tool.execute("call-1", { action: "kill", jobId: "test-job-6" });
    expect(text(killResult)).toContain("not running");
  });

  it("should require jobId for status action", async () => {
    const tool = createProcessTool({
      sessionKey: "test-session",
      agentId: "test-agent",
    });

    const result = await tool.execute("call-1", { action: "status" });

    expect(text(result)).toContain("jobId is required");
  });

  it("should require jobId for tail action", async () => {
    const tool = createProcessTool({
      sessionKey: "test-session",
      agentId: "test-agent",
    });

    const result = await tool.execute("call-1", { action: "tail" });

    expect(text(result)).toContain("jobId is required");
  });

  it("should require jobId for kill action", async () => {
    const tool = createProcessTool({
      sessionKey: "test-session",
      agentId: "test-agent",
    });

    const result = await tool.execute("call-1", { action: "kill" });

    expect(text(result)).toContain("jobId is required");
  });

  it("should list both running and finished processes", async () => {
    const tool = createProcessTool({
      sessionKey: "test-session",
      agentId: "test-agent",
    });

    const registry = getProcessRegistry(dbPath);

    registry.addSession({
      id: "test-job-running",
      sessionId: "test-session",
      agentId: "test-agent",
      command: "sleep 100",
      cwd: tempDir,
      backgrounded: true,
      pty: false,
    });

    registry.addSession({
      id: "test-job-finished",
      sessionId: "test-session",
      agentId: "test-agent",
      command: "echo done",
      cwd: tempDir,
      backgrounded: false,
      pty: false,
    });
    registry.appendOutput("test-job-finished", "done\n");
    registry.markExited({ id: "test-job-finished", exitCode: 0, signal: null });

    const result = await tool.execute("call-1", { action: "list" });

    expect(text(result)).toContain("Running");
    expect(text(result)).toContain("test-job-running");
    expect(text(result)).toContain("Finished");
    expect(text(result)).toContain("test-job-finished");
  });
});
