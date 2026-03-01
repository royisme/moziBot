import fs from "node:fs";
import os from "node:os";
import path from "node:path";
/**
 * Integration tests for ExecRuntime + ProcessSupervisor + ProcessRegistry.
 * These tests actually spawn real processes on the host.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { ProcessRegistry } from "../process/process-registry.js";
import {
  createProcessSupervisor,
  setProcessSupervisor,
  resetProcessSupervisor,
} from "../process/supervisor/index.js";
import { ExecRuntime } from "./exec-runtime.js";
import type { SandboxBoundary } from "./sandbox/config.js";

let tempDir: string;
let registry: ProcessRegistry;
let boundary: SandboxBoundary;
let runtime: ExecRuntime;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mozi-exec-int-"));
  registry = new ProcessRegistry(":memory:");
  boundary = {
    workspaceDir: tempDir,
    allowlist: ["echo", "sh", "bash", "sleep", "cat", "ls"],
    blockedEnvKeys: [],
    mode: "off",
  };
  setProcessSupervisor(createProcessSupervisor());
  runtime = new ExecRuntime(registry, boundary);
});

afterEach(() => {
  registry.close();
  resetProcessSupervisor();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("one-shot execution", () => {
  it("runs echo and captures stdout", async () => {
    const result = await runtime.execute({
      argv: ["echo", "hello-integration"],
      agentId: "agent-1",
      sessionKey: "session-1",
    });

    expect(result.type).toBe("completed");
    if (result.type === "completed") {
      expect(result.stdout).toContain("hello-integration");
      expect(result.exitCode).toBe(0);
    }
  });

  it("captures non-zero exit code", async () => {
    const result = await runtime.execute({
      argv: ["sh", "-c", "exit 42"],
      agentId: "agent-1",
      sessionKey: "session-1",
    });

    expect(result.type).toBe("completed");
    if (result.type === "completed") {
      expect(result.exitCode).toBe(42);
    }
  });

  it("captures stderr separately", async () => {
    const result = await runtime.execute({
      argv: ["sh", "-c", "echo out; echo err >&2"],
      agentId: "agent-1",
      sessionKey: "session-1",
    });

    expect(result.type).toBe("completed");
    if (result.type === "completed") {
      expect(result.stdout).toContain("out");
      expect(result.stderr).toContain("err");
    }
  });

  it("streams output via onUpdate callback", async () => {
    const chunks: string[] = [];
    const result = await runtime.execute(
      {
        argv: ["sh", "-c", "echo line1; echo line2; echo line3"],
        agentId: "agent-1",
        sessionKey: "session-1",
      },
      (update) => chunks.push(update.stdout),
    );

    expect(result.type).toBe("completed");
    const combined = chunks.join("");
    expect(combined).toContain("line1");
    expect(combined).toContain("line2");
    expect(combined).toContain("line3");
  });

  it("registers process in registry and marks exited", async () => {
    await runtime.execute({
      argv: ["echo", "registry-test"],
      agentId: "agent-1",
      sessionKey: "session-1",
    });

    const running = registry.getRunningProcesses("session-1");
    const finished = registry.getFinishedProcesses("session-1");
    expect(running.length).toBe(0);
    expect(finished.length).toBe(1);
    expect(finished[0].command).toBe("echo registry-test");
  });

  it("respects timeout", async () => {
    const result = await runtime.execute({
      argv: ["sleep", "100"],
      agentId: "agent-1",
      sessionKey: "session-1",
      timeoutSec: 1,
    });

    // exits due to timeout — exitCode will be 124 or signal-based
    expect(result.type).toBe("completed");
    if (result.type === "completed") {
      expect(result.exitCode).not.toBe(0);
    }
  }, 10_000);
});

describe("background execution", () => {
  it("returns backgrounded result immediately", async () => {
    const result = await runtime.execute({
      argv: ["sleep", "10"],
      agentId: "agent-1",
      sessionKey: "session-1",
      background: true,
    });

    expect(result.type).toBe("backgrounded");
    if (result.type === "backgrounded") {
      expect(result.jobId).toMatch(/^job_\d+_/);
      expect(result.pid).toBeGreaterThan(0);
      expect(result.message).toContain("background");
    }
  });

  it("registers backgrounded process in registry", async () => {
    await runtime.execute({
      argv: ["sleep", "10"],
      agentId: "agent-1",
      sessionKey: "session-1",
      background: true,
    });

    const running = registry.getRunningProcesses("session-1");
    expect(running.length).toBe(1);
    expect(running[0].backgrounded).toBe(true);
  });
});

describe("yieldMs execution", () => {
  it("yields after specified time with output so far", async () => {
    const result = await runtime.execute({
      argv: ["sh", "-c", "echo started; sleep 10"],
      agentId: "agent-1",
      sessionKey: "session-1",
      yieldMs: 500,
    });

    expect(result.type).toBe("yielded");
    if (result.type === "yielded") {
      expect(result.jobId).toMatch(/^job_\d+_/);
      expect(result.pid).toBeGreaterThan(0);
      expect(result.output).toContain("started");
      expect(result.message).toContain("still running");
    }
  }, 10_000);

  it("completes normally if process finishes before yieldMs", async () => {
    const result = await runtime.execute({
      argv: ["echo", "fast"],
      agentId: "agent-1",
      sessionKey: "session-1",
      yieldMs: 5000,
    });

    // Process finishes before yield timer
    expect(result.type).toBe("completed");
    if (result.type === "completed") {
      expect(result.stdout).toContain("fast");
    }
  }, 10_000);
});

describe("PTY execution", () => {
  it("runs a command in PTY mode", async () => {
    const result = await runtime.execute({
      argv: ["echo", "pty-output"],
      agentId: "agent-1",
      sessionKey: "session-1",
      pty: true,
    });

    expect(result.type).toBe("completed");
    if (result.type === "completed") {
      expect(result.stdout).toContain("pty-output");
      expect(result.exitCode).toBe(0);
    }
  }, 10_000);
});

describe("command validation (real boundary)", () => {
  it("rejects commands not in allowlist", async () => {
    const result = await runtime.execute({
      argv: ["curl", "https://example.com"],
      agentId: "agent-1",
      sessionKey: "session-1",
    });

    expect(result.type).toBe("error");
    if (result.type === "error") {
      expect(result.message).toContain("command not allowed: curl");
    }
  });

  it("rejects cwd outside workspace", async () => {
    const result = await runtime.execute({
      argv: ["echo", "hello"],
      cwd: "/etc",
      agentId: "agent-1",
      sessionKey: "session-1",
    });

    expect(result.type).toBe("error");
    if (result.type === "error") {
      expect(result.message).toContain("cwd must be within workspace");
    }
  });
});
