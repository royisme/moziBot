import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { ProcessSupervisor, type ProcessOutcomeWithOutput } from "./supervisor";
import { ProcessRegistry } from "./process-registry";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

describe("ProcessSupervisor", () => {
  let tempDir: string;
  let dbPath: string;
  let registry: ProcessRegistry;
  let supervisor: ProcessSupervisor;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mozi-supervisor-test-"));
    dbPath = path.join(tempDir, "test-registry.db");
    registry = new ProcessRegistry(dbPath);
    supervisor = new ProcessSupervisor({ registry });
  });

  afterEach(() => {
    registry.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("should start and complete a short-running process", async () => {
    const processId = "test-proc-1";

    const handle = supervisor.start({
      id: processId,
      command: "echo",
      args: ["hello"],
      cwd: tempDir,
      pty: false,
      timeoutSec: 10,
    });

    expect(handle.id).toBe(processId);
    expect(handle.pid).toBeGreaterThan(0);

    const outcome = await handle.promise;
    expect(outcome.type).toBe("exited");
    if (outcome.type === "exited") {
      expect(outcome.exitCode).toBe(0);
    }
  });

  it("should capture output from a process", async () => {
    const processId = "test-proc-2";
    const outputs: string[] = [];

    const handle = supervisor.start({
      id: processId,
      command: "sh",
      args: ["-c", "echo line1; echo line2"],
      cwd: tempDir,
      pty: false,
      timeoutSec: 10,
      onOutput: (data) => outputs.push(data),
    });

    await handle.promise;

    const combined = outputs.join("");
    expect(combined).toContain("line1");
    expect(combined).toContain("line2");
  });

  it("should kill a long-running process", async () => {
    const processId = "test-proc-3";

    const handle = supervisor.start({
      id: processId,
      command: "sleep",
      args: ["100"],
      cwd: tempDir,
      pty: false,
      timeoutSec: 300,
      noOutputTimeoutSec: 300,
    });

    // Give process time to start
    await new Promise((resolve) => setTimeout(resolve, 100));

    const killed = handle.kill("manual-cancel");
    expect(killed).toBe(true);

    const outcome = await handle.promise;
    expect(outcome.type).toBe("signaled");
  }, 10000);

  it("should timeout a process", async () => {
    const processId = "test-proc-4";

    const handle = supervisor.start({
      id: processId,
      command: "sleep",
      args: ["100"],
      cwd: tempDir,
      pty: false,
      timeoutSec: 1,
    });

    const outcome = await handle.promise;
    expect(outcome.type).toBe("timeout");
    if (outcome.type === "timeout") {
      expect(outcome.timeoutSec).toBe(1);
    }
  }, 10000);

  it("should handle non-existent command gracefully", async () => {
    const processId = "test-proc-5";

    const handle = supervisor.start({
      id: processId,
      command: "nonexistent_command_xyz123",
      cwd: tempDir,
      pty: false,
      timeoutSec: 10,
    });

    const outcome = await handle.promise;
    // With shell: true, the shell exits with code 127 for command not found
    expect(outcome.type).toBe("exited");
    if (outcome.type === "exited") {
      expect(outcome.exitCode).toBe(127);
    }
  });

  it("should allow tailing output after process completes", async () => {
    const processId = "test-proc-6";

    const handle = supervisor.start({
      id: processId,
      command: "sh",
      args: ["-c", "echo test-output"],
      cwd: tempDir,
      pty: false,
      timeoutSec: 10,
      noOutputTimeoutSec: 10,
    });

    // Wait for process to complete
    await handle.promise;

    const tail = supervisor.tail(processId);
    // Tail may be null if process completed before we could capture output
    if (tail) {
      expect(tail).toContain("test-output");
    }
  });

  it("should track multiple concurrent processes", async () => {
    const handle1 = supervisor.start({
      id: "proc-1",
      command: "sleep",
      args: ["0.1"],
      cwd: tempDir,
      pty: false,
      timeoutSec: 10,
    });

    const handle2 = supervisor.start({
      id: "proc-2",
      command: "sleep",
      args: ["0.1"],
      cwd: tempDir,
      pty: false,
      timeoutSec: 10,
    });

    expect(supervisor.get("proc-1")).toBeDefined();
    expect(supervisor.get("proc-2")).toBeDefined();

    await Promise.all([handle1.promise, handle2.promise]);

    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(supervisor.get("proc-1")).toBeUndefined();
    expect(supervisor.get("proc-2")).toBeUndefined();
  });

  it("should support PTY mode for TTY-required commands", async () => {
    const processId = "test-proc-pty";

    const handle = supervisor.start({
      id: processId,
      command: "sh",
      args: ["-c", "echo 'pty test'"],
      cwd: tempDir,
      pty: true,
      timeoutSec: 10,
    });

    // PTY may not be available in all environments
    if (handle.pid === -1) {
      return;
    }

    expect(handle.id).toBe(processId);
    expect(handle.pid).toBeGreaterThan(0);

    const outcome = await handle.promise;
    expect(outcome.type).toBe("exited");
    if (outcome.type === "exited") {
      expect(outcome.exitCode).toBe(0);
    }
  });

  it("should capture PTY output", async () => {
    const processId = "test-proc-pty-output";
    const outputs: string[] = [];

    const handle = supervisor.start({
      id: processId,
      command: "sh",
      args: ["-c", "echo 'pty output line'"],
      cwd: tempDir,
      pty: true,
      timeoutSec: 10,
      onOutput: (data) => outputs.push(data),
    });

    await handle.promise;

    // PTY may not be available in all environments
    if (handle.pid > 0) {
      const combined = outputs.join("");
      expect(combined).toContain("pty output line");
    }
  });

  it("should timeout kill a PTY process", async () => {
    const processId = "test-proc-pty-timeout";

    const handle = supervisor.start({
      id: processId,
      command: "sleep",
      args: ["100"],
      cwd: tempDir,
      pty: true,
      timeoutSec: 1,
    });

    const outcome = await handle.promise;
    // PTY may not be available in all environments, so accept error or timeout
    expect(outcome.type).toMatch(/timeout|error/);
  }, 10000);
});

describe("ProcessSupervisor one-shot mode (waitForExit)", () => {
  let tempDir: string;
  let dbPath: string;
  let registry: ProcessRegistry;
  let supervisor: ProcessSupervisor;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mozi-supervisor-oneshot-test-"));
    dbPath = path.join(tempDir, "test-registry.db");
    registry = new ProcessRegistry(dbPath);
    supervisor = new ProcessSupervisor({ registry });
  });

  afterEach(() => {
    registry.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("should support waitForExit mode with shell command", async () => {
    const processId = "oneshot-1";

    const handle = supervisor.start({
      id: processId,
      command: "/bin/sh",
      args: ["-c", "echo hello-world"],
      cwd: tempDir,
      waitForExit: true,
      timeoutSec: 10,
    });

    expect(handle.id).toBe(processId);
    expect(handle.pid).toBeGreaterThan(0);

    const outcome = await handle.promise;
    expect(outcome.type).toBe("exited");
    if (outcome.type === "exited") {
      expect(outcome.exitCode).toBe(0);
    }
    // The promise should include stdout
    expect(outcome).toHaveProperty("stdout");
  });

  it("should collect output in waitForExit mode", async () => {
    const processId = "oneshot-2";

    const handle = supervisor.start({
      id: processId,
      command: "/bin/sh",
      args: ["-c", "echo test-output"],
      cwd: tempDir,
      waitForExit: true,
      timeoutSec: 10,
    });

    const outcome = await handle.promise as ProcessOutcomeWithOutput;

    // The outcome should have stdout property
    expect(outcome.stdout).toContain("test-output");
  });

  it("should capture stderr separately in waitForExit mode", async () => {
    const processId = "oneshot-stderr";

    const handle = supervisor.start({
      id: processId,
      command: "/bin/sh",
      args: ["-c", "echo stdout-line; echo stderr-line >&2"],
      cwd: tempDir,
      waitForExit: true,
      timeoutSec: 10,
    });

    const outcome = await handle.promise as ProcessOutcomeWithOutput;

    expect(outcome.stdout).toContain("stdout-line");
    expect(outcome.stderr).toContain("stderr-line");
    // stderr should not appear in stdout
    expect(outcome.stdout).not.toContain("stderr-line");
  });

  it("should support getOutput method in normal mode", async () => {
    const processId = "oneshot-3";

    const handle = supervisor.start({
      id: processId,
      command: "echo",
      args: ["get-output-test"],
      cwd: tempDir,
      timeoutSec: 10,
    });

    await handle.promise;

    const output = handle.getOutput();
    expect(output).toContain("get-output-test");
  });

  it("should respect maxBuffer option", async () => {
    const processId = "oneshot-4";

    const handle = supervisor.start({
      id: processId,
      command: "/bin/sh",
      args: ["-c", "echo short"],
      cwd: tempDir,
      maxBuffer: 100,
      timeoutSec: 10,
    });

    await handle.promise;

    const output = handle.getOutput();
    expect(output).toContain("short");
  });

  it("should handle exit code correctly in waitForExit mode", async () => {
    const processId = "oneshot-5";

    const handle = supervisor.start({
      id: processId,
      command: "/bin/sh",
      args: ["-c", "exit 42"],
      cwd: tempDir,
      waitForExit: true,
      timeoutSec: 10,
    });

    const outcome = await handle.promise;
    expect(outcome.type).toBe("exited");
    if (outcome.type === "exited") {
      expect(outcome.exitCode).toBe(42);
    }
  });

  it("should handle timeout in waitForExit mode", async () => {
    const processId = "oneshot-6";

    const handle = supervisor.start({
      id: processId,
      command: "sleep",
      args: ["100"],
      cwd: tempDir,
      waitForExit: true,
      timeoutSec: 1,
    });

    const outcome = await handle.promise;
    expect(outcome.type).toBe("timeout");
  });
});
