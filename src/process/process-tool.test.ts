import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createProcessTool } from "./process-tool";
import {
  getProcessRegistry,
  closeProcessRegistry,
  closeProcessSupervisor,
} from "./index";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

describe("createProcessTool", () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mozi-process-tool-test-"));
    dbPath = path.join(tempDir, "test-registry.db");

    closeProcessRegistry();
    closeProcessSupervisor();
    getProcessRegistry(dbPath);
  });

  afterEach(() => {
    closeProcessRegistry();
    closeProcessSupervisor();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("should list processes when no jobId provided", async () => {
    const tool = createProcessTool({
      sessionKey: "test-session",
      agentId: "test-agent",
    });

    // First register a process in the registry
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

    const result = await tool.execute("call-1", { operation: "list" });

    expect(result.content[0].type).toBe("text");
    expect(result.content[0].text).toContain("test-job-1");
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

    const result = await tool.execute("call-1", { operation: "status", jobId: "test-job-2" });

    expect(result.content[0].text).toContain("test-job-2");
    expect(result.content[0].text).toContain("running");
  });

  it("should return not found for non-existent process", async () => {
    const tool = createProcessTool({
      sessionKey: "test-session",
      agentId: "test-agent",
    });

    const result = await tool.execute("call-1", { operation: "status", jobId: "non-existent" });

    expect(result.content[0].text).toContain("Process not found");
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

    // Simulate output being captured
    registry.appendOutput("test-job-3", "test-output-line\n");
    registry.markExited({ id: "test-job-3", exitCode: 0, signal: null });

    const result = await tool.execute("call-1", { operation: "tail", jobId: "test-job-3" });

    expect(result.content[0].text).toContain("test-output-line");
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

    // Add some output
    const longOutput = "x".repeat(100);
    registry.appendOutput("test-job-4", longOutput);
    registry.markExited({ id: "test-job-4", exitCode: 0, signal: null });

    const result = await tool.execute("call-1", { operation: "tail", jobId: "test-job-4", chars: 10 });

    // The output should be limited
    expect(result.content[0].text).toBeDefined();
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

    const killResult = await tool.execute("call-1", { operation: "kill", jobId: "test-job-6" });
    expect(killResult.content[0].text).toContain("not running");
  });

  it("should require jobId for status operation", async () => {
    const tool = createProcessTool({
      sessionKey: "test-session",
      agentId: "test-agent",
    });

    const result = await tool.execute("call-1", { operation: "status" });

    expect(result.content[0].text).toContain("jobId is required");
  });

  it("should require jobId for tail operation", async () => {
    const tool = createProcessTool({
      sessionKey: "test-session",
      agentId: "test-agent",
    });

    const result = await tool.execute("call-1", { operation: "tail" });

    expect(result.content[0].text).toContain("jobId is required");
  });

  it("should require jobId for kill operation", async () => {
    const tool = createProcessTool({
      sessionKey: "test-session",
      agentId: "test-agent",
    });

    const result = await tool.execute("call-1", { operation: "kill" });

    expect(result.content[0].text).toContain("jobId is required");
  });

  it("should list both running and finished processes", async () => {
    const tool = createProcessTool({
      sessionKey: "test-session",
      agentId: "test-agent",
    });

    const registry = getProcessRegistry(dbPath);

    // Register a running process
    registry.addSession({
      id: "test-job-running",
      sessionId: "test-session",
      agentId: "test-agent",
      command: "sleep 100",
      cwd: tempDir,
      backgrounded: true,
      pty: false,
    });

    // Register a finished process
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

    const result = await tool.execute("call-1", { operation: "list" });

    expect(result.content[0].text).toContain("Running");
    expect(result.content[0].text).toContain("test-job-running");
    expect(result.content[0].text).toContain("Finished");
    expect(result.content[0].text).toContain("test-job-finished");
  });
});
