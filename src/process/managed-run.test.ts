import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { ManagedRun } from "./managed-run";
import { ProcessSupervisor } from "./supervisor";
import { ProcessRegistry } from "./process-registry";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

describe("ManagedRun", () => {
  let tempDir: string;
  let dbPath: string;
  let registry: ProcessRegistry;
  let supervisor: ProcessSupervisor;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mozi-managed-test-"));
    dbPath = path.join(tempDir, "test-registry.db");
    registry = new ProcessRegistry(dbPath);
    supervisor = new ProcessSupervisor({ registry });
  });

  afterEach(() => {
    registry.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("should wrap a process handle and track status", async () => {
    const handle = supervisor.start({
      id: "test-run-1",
      command: "echo",
      args: ["hello"],
      cwd: tempDir,
      pty: false,
      timeoutSec: 10,
    });

    const managedRun = new ManagedRun(handle);

    expect(managedRun.getStatus()).toBe("running");
    expect(managedRun.id).toBe("test-run-1");
    expect(managedRun.pid).toBeGreaterThan(0);

    const outcome = await managedRun.promise;
    expect(outcome.status).toBe("exited");
    expect(managedRun.getStatus()).toBe("exited");
    expect(outcome.reason).toBe("exit");
  });

  it("should capture output via onOutput callback", async () => {
    const handle = supervisor.start({
      id: "test-run-2",
      command: "sh",
      args: ["-c", "echo line1; echo line2"],
      cwd: tempDir,
      pty: false,
      timeoutSec: 10,
    });

    const managedRun = new ManagedRun(handle);
    const outputs: string[] = [];

    managedRun.onOutput((data) => {
      outputs.push(data);
    });

    await managedRun.promise;

    const combined = outputs.join("");
    expect(combined).toContain("line1");
    expect(combined).toContain("line2");
  });

  it("should provide getOutput for buffered output", async () => {
    const handle = supervisor.start({
      id: "test-run-3",
      command: "sh",
      args: ["-c", "echo test-buffer-output"],
      cwd: tempDir,
      pty: false,
      timeoutSec: 10,
    });

    const managedRun = new ManagedRun(handle);
    await managedRun.promise;

    const output = managedRun.getOutput();
    expect(output).toContain("test-buffer-output");
  });

  it("should kill the process and update status", async () => {
    const handle = supervisor.start({
      id: "test-run-4",
      command: "sleep",
      args: ["100"],
      cwd: tempDir,
      pty: false,
      timeoutSec: 300,
    });

    const managedRun = new ManagedRun(handle);

    expect(managedRun.getStatus()).toBe("running");

    const killed = managedRun.kill("manual-cancel");
    expect(killed).toBe(true);
    expect(managedRun.getStatus()).toBe("exited");

    const outcome = await managedRun.promise;
    expect(outcome.status).toBe("exited");
    expect(outcome.reason).toBe("signal");
  });

  it("should not allow killing an already exited process", async () => {
    const handle = supervisor.start({
      id: "test-run-5",
      command: "echo",
      args: ["quick"],
      cwd: tempDir,
      pty: false,
      timeoutSec: 10,
    });

    const managedRun = new ManagedRun(handle);
    await managedRun.promise;

    expect(managedRun.getStatus()).toBe("exited");

    const killed = managedRun.kill();
    expect(killed).toBe(false);
  });

  it("should handle timeout outcome", async () => {
    const handle = supervisor.start({
      id: "test-run-6",
      command: "sleep",
      args: ["100"],
      cwd: tempDir,
      pty: false,
      timeoutSec: 1,
    });

    const managedRun = new ManagedRun(handle);
    const outcome = await managedRun.promise;

    expect(outcome.status).toBe("exited");
    expect(outcome.signal).toBe("SIGKILL");
    expect(outcome.reason).toBe("timeout");
    expect(outcome.timeoutSec).toBe(1);
  });

  it("should handle error outcome", async () => {
    const handle = supervisor.start({
      id: "test-run-7",
      command: "nonexistent_command_xyz",
      cwd: tempDir,
      pty: false,
      timeoutSec: 10,
    });

    const managedRun = new ManagedRun(handle);
    const outcome = await managedRun.promise;

    // Non-existent commands may result in exit with non-zero code or error
    // depending on how the shell handles them
    expect(outcome.status).toMatch(/exited|error/);
    if (outcome.status === "error") {
      expect(outcome.error).toBeDefined();
      expect(outcome.reason).toBe("spawn-error");
    } else {
      // Shell returned non-zero exit code for unknown command
      expect(outcome.exitCode).not.toBe(0);
    }
  });

  it("should get outcome after completion", async () => {
    const handle = supervisor.start({
      id: "test-run-8",
      command: "sh",
      args: ["-c", "exit 42"],
      cwd: tempDir,
      pty: false,
      timeoutSec: 10,
    });

    const managedRun = new ManagedRun(handle);
    await managedRun.promise;

    const outcome = managedRun.getOutcome();
    expect(outcome).not.toBeNull();
    expect(outcome?.status).toBe("exited");
    expect(outcome?.exitCode).toBe(42);
    expect(outcome?.reason).toBe("exit");
  });

  it("should provide stdin access for PTY processes", async () => {
    const handle = supervisor.start({
      id: "test-run-pty",
      command: "cat",
      cwd: tempDir,
      pty: true,
      timeoutSec: 10,
    });

    const managedRun = new ManagedRun(handle);
    
    // PTY may not be available in all environments
    if (managedRun.pid === -1) {
      // PTY spawn failed, skip this test
      return;
    }
    
    expect(managedRun.stdin).toBeDefined();

    // Write to stdin
    managedRun.stdin?.write("test input\n");

    // Kill after short delay
    setTimeout(() => managedRun.kill(), 100);

    const outcome = await managedRun.promise;
    expect(outcome.status).toBe("exited");
  });

  it("should handle no-output timeout", async () => {
    const handle = supervisor.start({
      id: "test-run-no-output",
      command: "sleep",
      args: ["100"],
      cwd: tempDir,
      pty: false,
      timeoutSec: 300,
      noOutputTimeoutSec: 1,
    });

    const managedRun = new ManagedRun(handle);
    const outcome = await managedRun.promise;

    expect(outcome.status).toBe("exited");
    expect(outcome.reason).toBe("no-output-timeout");
  });

  it("should track termination reason", async () => {
    const handle = supervisor.start({
      id: "test-run-reason",
      command: "sleep",
      args: ["100"],
      cwd: tempDir,
      pty: false,
      timeoutSec: 300,
    });

    const managedRun = new ManagedRun(handle);
    managedRun.kill("manual-cancel");
    const outcome = await managedRun.promise;

    expect(outcome.reason).toBe("signal");
  });
});
