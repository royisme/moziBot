import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { ProcessRegistry } from "./process-registry";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

describe("ProcessRegistry", () => {
  let tempDir: string;
  let dbPath: string;
  let registry: ProcessRegistry;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mozi-registry-test-"));
    dbPath = path.join(tempDir, "test-registry.db");
    registry = new ProcessRegistry(dbPath);
  });

  afterEach(() => {
    registry.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("should add a session and retrieve it", () => {
    const sessionId = "test-session-1";
    const processId = "proc-1";

    registry.addSession({
      id: processId,
      sessionId,
      agentId: "agent-1",
      command: "echo hello",
      cwd: "/tmp",
      backgrounded: true,
      pty: false,
    });

    const record = registry.getStatus(processId);
    expect(record).not.toBeNull();
    expect(record?.id).toBe(processId);
    expect(record?.command).toBe("echo hello");
    expect(record?.status).toBe("running");
    expect(record?.backgrounded).toBe(true);
    expect(record?.pty).toBe(false);
  });

  it("should append output and retrieve tail", () => {
    const processId = "proc-2";

    registry.addSession({
      id: processId,
      sessionId: "session-1",
      agentId: "agent-1",
      command: "test",
      cwd: "/tmp",
      backgrounded: false,
      pty: false,
    });

    registry.appendOutput(processId, "line1\n");
    registry.appendOutput(processId, "line2\n");
    registry.appendOutput(processId, "line3\n");

    const tail = registry.tail(processId);
    expect(tail).toBe("line1\nline2\nline3\n");
  });

  it("should limit output tail size", () => {
    const processId = "proc-3";

    registry.addSession({
      id: processId,
      sessionId: "session-1",
      agentId: "agent-1",
      command: "test",
      cwd: "/tmp",
      backgrounded: false,
      pty: false,
    });

    const largeOutput = "x".repeat(50 * 1024);
    registry.appendOutput(processId, largeOutput);

    const tail = registry.tail(processId);
    expect(tail).not.toBeNull();
    expect(tail?.length).toBeLessThanOrEqual(32 * 1024);
  });

  it("should mark process as exited", () => {
    const processId = "proc-4";

    registry.addSession({
      id: processId,
      sessionId: "session-1",
      agentId: "agent-1",
      command: "test",
      cwd: "/tmp",
      backgrounded: false,
      pty: false,
    });

    registry.markExited({ id: processId, exitCode: 0, signal: null });

    const record = registry.getStatus(processId);
    expect(record?.status).toBe("exited");
    expect(record?.exitCode).toBe(0);
  });

  it("should get running processes for session", () => {
    registry.addSession({
      id: "proc-1",
      sessionId: "session-1",
      agentId: "agent-1",
      command: "test1",
      cwd: "/tmp",
      backgrounded: true,
      pty: false,
    });

    registry.addSession({
      id: "proc-2",
      sessionId: "session-1",
      agentId: "agent-1",
      command: "test2",
      cwd: "/tmp",
      backgrounded: true,
      pty: false,
    });

    registry.addSession({
      id: "proc-3",
      sessionId: "session-2",
      agentId: "agent-1",
      command: "test3",
      cwd: "/tmp",
      backgrounded: true,
      pty: false,
    });

    registry.markExited({ id: "proc-2", exitCode: 0, signal: null });

    const running = registry.getRunningProcesses("session-1");
    expect(running).toHaveLength(1);
    expect(running[0].id).toBe("proc-1");
  });

  it("should get finished processes for session", () => {
    registry.addSession({
      id: "proc-1",
      sessionId: "session-1",
      agentId: "agent-1",
      command: "test1",
      cwd: "/tmp",
      backgrounded: true,
      pty: false,
    });

    registry.markExited({ id: "proc-1", exitCode: 0, signal: null });

    const finished = registry.getFinishedProcesses("session-1");
    expect(finished).toHaveLength(1);
    expect(finished[0].id).toBe("proc-1");
    expect(finished[0].status).toBe("exited");
  });

  it("should return null for non-existent process", () => {
    const record = registry.getStatus("non-existent");
    expect(record).toBeNull();
  });

  it("should cleanup old sessions", async () => {
    registry.addSession({
      id: "old-proc",
      sessionId: "session-1",
      agentId: "agent-1",
      command: "test",
      cwd: "/tmp",
      backgrounded: false,
      pty: false,
    });

    registry.markExited({ id: "old-proc", exitCode: 0, signal: null });

    // Wait to ensure the process is old enough
    await new Promise((resolve) => setTimeout(resolve, 150));
    const cleaned = registry.cleanupOldSessions("session-1", 100); // 100ms TTL
    expect(cleaned).toBe(1);

    const record = registry.getStatus("old-proc");
    expect(record).toBeNull();
  });

  it("should mark process as backgrounded", () => {
    const processId = "proc-bg";

    registry.addSession({
      id: processId,
      sessionId: "session-1",
      agentId: "agent-1",
      command: "test",
      cwd: "/tmp",
      backgrounded: false,
      pty: false,
    });

    registry.markBackgrounded(processId);

    const record = registry.getStatus(processId);
    expect(record?.backgrounded).toBe(true);
  });

  it("should track total output characters", () => {
    const processId = "proc-total";

    registry.addSession({
      id: processId,
      sessionId: "session-1",
      agentId: "agent-1",
      command: "test",
      cwd: "/tmp",
      backgrounded: false,
      pty: false,
    });

    registry.appendOutput(processId, "line1\n");
    registry.appendOutput(processId, "line2\n");

    const record = registry.getStatus(processId);
    expect(record?.totalOutputChars).toBe(12); // "line1\n" + "line2\n" = 6 + 6 = 12
  });

  it("should get all processes for session", () => {
    registry.addSession({
      id: "proc-1",
      sessionId: "session-1",
      agentId: "agent-1",
      command: "test1",
      cwd: "/tmp",
      backgrounded: true,
      pty: false,
    });

    registry.addSession({
      id: "proc-2",
      sessionId: "session-1",
      agentId: "agent-1",
      command: "test2",
      cwd: "/tmp",
      backgrounded: true,
      pty: false,
    });

    registry.markExited({ id: "proc-1", exitCode: 0, signal: null });

    const all = registry.getAllProcesses("session-1");
    expect(all).toHaveLength(2);
  });

  it("should cleanup all old sessions", async () => {
    registry.addSession({
      id: "old-proc-1",
      sessionId: "session-1",
      agentId: "agent-1",
      command: "test1",
      cwd: "/tmp",
      backgrounded: false,
      pty: false,
    });

    registry.addSession({
      id: "old-proc-2",
      sessionId: "session-2",
      agentId: "agent-1",
      command: "test2",
      cwd: "/tmp",
      backgrounded: false,
      pty: false,
    });

    registry.markExited({ id: "old-proc-1", exitCode: 0, signal: null });
    registry.markExited({ id: "old-proc-2", exitCode: 0, signal: null });

    // Wait to ensure the processes are old enough
    await new Promise((resolve) => setTimeout(resolve, 150));
    const cleaned = registry.cleanupAllOldSessions(100); // 100ms TTL
    expect(cleaned).toBe(2);
  });

  it("should track endedAt timestamp", () => {
    const processId = "proc-ended";

    const beforeExit = Date.now();
    registry.addSession({
      id: processId,
      sessionId: "session-1",
      agentId: "agent-1",
      command: "test",
      cwd: "/tmp",
      backgrounded: false,
      pty: false,
    });

    registry.markExited({ id: processId, exitCode: 0, signal: null });
    const afterExit = Date.now();

    const record = registry.getStatus(processId);
    expect(record?.endedAt).toBeDefined();
    expect(record?.endedAt!).toBeGreaterThanOrEqual(beforeExit);
    expect(record?.endedAt!).toBeLessThanOrEqual(afterExit);
  });
});
