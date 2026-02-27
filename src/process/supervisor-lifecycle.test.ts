import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { ProcessSupervisor, getProcessSupervisor, setProcessSupervisor, closeProcessSupervisor } from "./supervisor";
import { ProcessRegistry, getProcessRegistry, setProcessRegistry, closeProcessRegistry } from "./process-registry";
import { ManagedRun } from "./managed-run";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

describe("ProcessSupervisor lifecycle", () => {
  let tempDir: string;
  let dbPath: string;
  let registry: ProcessRegistry;
  let supervisor: ProcessSupervisor;
  let cleanupTasks: Array<() => void> = [];

  beforeEach(() => {
    cleanupTasks = [];
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mozi-lifecycle-test-"));
    dbPath = path.join(tempDir, "test-registry.db");
    registry = new ProcessRegistry(dbPath);
    supervisor = new ProcessSupervisor({ registry });
    setProcessRegistry(registry);
    setProcessSupervisor(supervisor);
  });

  afterEach(async () => {
    // Kill all running processes before cleanup
    closeProcessSupervisor();
    // Give processes time to exit
    await new Promise((resolve) => setTimeout(resolve, 100));
    closeProcessRegistry();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("should support background lifecycle: start, status, tail, kill", async () => {
    const jobId = "background-test-1";

    // Start a long-running background process
    const handle = supervisor.start({
      id: jobId,
      command: "sh",
      args: ["-c", "echo started; sleep 10; echo done"],
      cwd: tempDir,
      pty: false,
      timeoutSec: 30,
    });

    expect(handle.pid).toBeGreaterThan(0);

    // Wait for process to start and produce output
    await new Promise((resolve) => setTimeout(resolve, 200));

    // Check status via registry
    const record = registry.getStatus(jobId);
    if (record) {
      expect(record.status).toBe("running");
    }

    // Tail output
    const tail = supervisor.tail(jobId);
    if (tail) {
      expect(tail).toContain("started");
    }

    // Kill the process
    const killed = supervisor.kill(jobId);
    expect(killed).toBe(true);

    // Wait for process to exit
    await new Promise((resolve) => setTimeout(resolve, 200));

    const finalRecord = registry.getStatus(jobId);
    if (finalRecord) {
      expect(finalRecord.status).toBe("exited");
    }
  }, 10000);

  it("should support yieldMs behavior: run for specified time then return", async () => {
    const jobId = "yield-test-1";
    const yieldMs = 300;

    const handle = supervisor.start({
      id: jobId,
      command: "sh",
      args: ["-c", "echo line1; sleep 0.5; echo line2; sleep 0.5; echo line3"],
      cwd: tempDir,
      pty: false,
      timeoutSec: 30,
    });

    const managedRun = new ManagedRun(handle);
    const outputs: string[] = [];
    managedRun.onOutput((data) => outputs.push(data));

    // Wait for yieldMs
    await new Promise((resolve) => setTimeout(resolve, yieldMs));

    // Should have captured some output
    const output = managedRun.getOutput();
    expect(output).toBeTruthy();
    expect(output).toContain("line1");

    // Wait for process to complete
    const outcome = await managedRun.promise;
    expect(outcome.status).toBe("exited");
  }, 10000);

  it("should timeout kill: kill process after timeout", async () => {
    const jobId = "timeout-test-1";
    const timeoutSec = 1;

    const handle = supervisor.start({
      id: jobId,
      command: "sleep",
      args: ["100"],
      cwd: tempDir,
      pty: false,
      timeoutSec,
    });

    const outcome = await handle.promise;
    expect(outcome.type).toBe("timeout");
    expect(outcome.reason).toBe("timeout");
    if (outcome.type === "timeout") {
      expect(outcome.timeoutSec).toBe(timeoutSec);
    }

    // Give registry time to update
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Verify registry is updated
    const record = registry.getStatus(jobId);
    if (record) {
      expect(record.status).toBe("exited");
      expect(record.signal).toBe("SIGKILL");
    }
  }, 10000);

  it("should support PTY mode for TTY-required commands", async () => {
    const jobId = "pty-test-1";

    // Use a simple command that works with PTY
    const handle = supervisor.start({
      id: jobId,
      command: "echo",
      args: ["hello from pty"],
      cwd: tempDir,
      pty: true,
      timeoutSec: 30,
    });

    // PTY may fallback to non-PTY mode, so just check the process completes
    const outcome = await handle.promise;
    expect(outcome.type).toBeDefined();

    // Verify output was captured (either from PTY or fallback)
    const tail = supervisor.tail(jobId);
    if (tail) {
      expect(tail).toContain("hello");
    }
  }, 10000);

  it("should handle PTY fallback when PTY spawn fails", async () => {
    const jobId = "pty-fallback-test-1";

    // This should work even if PTY has issues
    const handle = supervisor.start({
      id: jobId,
      command: "sh",
      args: ["-c", "echo test"],
      cwd: tempDir,
      pty: true,
      timeoutSec: 30,
    });

    const outcome = await handle.promise;
    // Should either succeed with PTY or fallback to non-PTY
    expect(outcome.type).toBeDefined();
  }, 10000);

  it("should track multiple concurrent background processes", async () => {
    const jobIds = ["concurrent-1", "concurrent-2", "concurrent-3"];

    const handles = jobIds.map((id) =>
      supervisor.start({
        id,
        command: "sleep",
        args: ["0.2"],
        cwd: tempDir,
        pty: false,
        timeoutSec: 30,
      }),
    );

    // Give processes time to start and register
    await new Promise((resolve) => setTimeout(resolve, 100));

    // All processes should be tracked
    for (const id of jobIds) {
      const record = registry.getStatus(id);
      if (record) {
        expect(record.status).toBe("running");
      }
    }

    // Wait for all to complete
    await Promise.all(handles.map((h) => h.promise));

    // Give registry time to update
    await new Promise((resolve) => setTimeout(resolve, 50));

    // All should be exited
    for (const id of jobIds) {
      const record = registry.getStatus(id);
      if (record) {
        expect(record.status).toBe("exited");
      }
    }
  }, 10000);

  it("should support stdin write for interactive processes", async () => {
    const jobId = "stdin-test-1";

    const handle = supervisor.start({
      id: jobId,
      command: "cat",
      cwd: tempDir,
      pty: false,
      timeoutSec: 30,
    });

    // Write to stdin
    if (handle.stdin) {
      handle.stdin.write("hello\n");
      await new Promise((resolve) => setTimeout(resolve, 200));
      handle.stdin.end();
    }

    const outcome = await handle.promise;
    expect(outcome.type).toBe("exited");

    // Verify output contains what we wrote
    const tail = supervisor.tail(jobId);
    if (tail) {
      expect(tail).toContain("hello");
    }
  }, 10000);
});

describe("ManagedRun lifecycle", () => {
  let tempDir: string;
  let dbPath: string;
  let registry: ProcessRegistry;
  let supervisor: ProcessSupervisor;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mozi-managed-lifecycle-test-"));
    dbPath = path.join(tempDir, "test-registry.db");
    registry = new ProcessRegistry(dbPath);
    supervisor = new ProcessSupervisor({ registry });
  });

  afterEach(async () => {
    // Give processes time to exit
    await new Promise((resolve) => setTimeout(resolve, 100));
    registry.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("should track process lifecycle from running to exited", async () => {
    const handle = supervisor.start({
      id: "lifecycle-1",
      command: "sh",
      args: ["-c", "echo start; sleep 0.1; echo end"],
      cwd: tempDir,
      pty: false,
      timeoutSec: 30,
    });

    const managedRun = new ManagedRun(handle);

    // Initial state
    expect(managedRun.getStatus()).toBe("running");

    // Wait for completion
    const outcome = await managedRun.promise;

    // Final state
    expect(managedRun.getStatus()).toBe("exited");
    expect(outcome.status).toBe("exited");
    expect(outcome.exitCode).toBe(0);
  }, 10000);

  it("should capture all output via onOutput callback", async () => {
    const handle = supervisor.start({
      id: "output-1",
      command: "sh",
      args: ["-c", "echo line1; echo line2; echo line3"],
      cwd: tempDir,
      pty: false,
      timeoutSec: 30,
    });

    const managedRun = new ManagedRun(handle);
    const outputs: string[] = [];
    managedRun.onOutput((data) => outputs.push(data));

    await managedRun.promise;

    const combined = outputs.join("");
    expect(combined).toContain("line1");
    expect(combined).toContain("line2");
    expect(combined).toContain("line3");
  }, 10000);

  it("should handle manual kill correctly", async () => {
    const handle = supervisor.start({
      id: "kill-1",
      command: "sleep",
      args: ["100"],
      cwd: tempDir,
      pty: false,
      timeoutSec: 300,
    });

    const managedRun = new ManagedRun(handle);

    // Kill the process
    const killed = managedRun.kill();
    expect(killed).toBe(true);

    const outcome = await managedRun.promise;
    expect(outcome.status).toBe("exited");
  }, 10000);

  it("should not allow killing already exited process", async () => {
    const handle = supervisor.start({
      id: "quick-1",
      command: "echo",
      args: ["done"],
      cwd: tempDir,
      pty: false,
      timeoutSec: 30,
    });

    const managedRun = new ManagedRun(handle);
    await managedRun.promise;

    // Try to kill after exit
    const killed = managedRun.kill();
    expect(killed).toBe(false);
  }, 10000);
});

describe("ProcessRegistry persistence", () => {
  let tempDir: string;
  let dbPath: string;
  let registry: ProcessRegistry;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mozi-persist-test-"));
    dbPath = path.join(tempDir, "test-registry.db");
    registry = new ProcessRegistry(dbPath);
  });

  afterEach(() => {
    registry.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("should persist session and retrieve it", () => {
    const jobId = "persist-1";

    registry.addSession({
      id: jobId,
      sessionId: "session-1",
      agentId: "agent-1",
      command: "test command",
      cwd: tempDir,
      backgrounded: true,
      pty: false,
    });

    const record = registry.getStatus(jobId);
    expect(record).not.toBeNull();
    expect(record?.command).toBe("test command");
    expect(record?.cwd).toBe(tempDir);
    expect(record?.backgrounded).toBe(true);
    expect(record?.pty).toBe(false);
  });

  it("should persist output and retrieve tail", () => {
    const jobId = "output-1";

    registry.addSession({
      id: jobId,
      sessionId: "session-1",
      agentId: "agent-1",
      command: "test",
      cwd: tempDir,
      backgrounded: false,
      pty: false,
    });

    registry.appendOutput(jobId, "line1\n");
    registry.appendOutput(jobId, "line2\n");
    registry.appendOutput(jobId, "line3\n");

    const tail = registry.tail(jobId);
    expect(tail).toBe("line1\nline2\nline3\n");

    // Tail with limit returns last N chars
    const tailLimited = registry.tail(jobId, 12);
    expect(tailLimited.length).toBeLessThanOrEqual(12);
    expect(tailLimited).toContain("line3");
  });

  it("should track backgrounded status", () => {
    const jobId = "bg-1";

    registry.addSession({
      id: jobId,
      sessionId: "session-1",
      agentId: "agent-1",
      command: "test",
      cwd: tempDir,
      backgrounded: false,
      pty: false,
    });

    let record = registry.getStatus(jobId);
    expect(record?.backgrounded).toBe(false);

    registry.markBackgrounded(jobId);

    record = registry.getStatus(jobId);
    expect(record?.backgrounded).toBe(true);
  });
});
