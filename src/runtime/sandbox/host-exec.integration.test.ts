import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { hostExec } from "./host-exec";

describe("hostExec", () => {
  it("runs command within workspace", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "mozi-host-exec-"));
    const result = await hostExec({
      workspaceDir,
      command: "pwd",
    });
    expect(result.exitCode).toBe(0);
    const resolved = await fs.realpath(workspaceDir);
    expect(result.stdout.trim()).toBe(resolved);
    await fs.rm(workspaceDir, { recursive: true, force: true });
  });

  it("rejects cwd outside workspace", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "mozi-host-exec-"));
    let error: unknown;
    try {
      await hostExec({
        workspaceDir,
        command: "pwd",
        cwd: "..",
      });
    } catch (err) {
      error = err;
    }
    expect((error as Error | undefined)?.message).toContain("cwd must be within workspace");
    await fs.rm(workspaceDir, { recursive: true, force: true });
  });

  it("rejects PATH override", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "mozi-host-exec-"));
    let error: unknown;
    try {
      await hostExec({
        workspaceDir,
        command: "pwd",
        env: { PATH: "/tmp" },
      });
    } catch (err) {
      error = err;
    }
    expect((error as Error | undefined)?.message).toContain("env PATH is not allowed");
    await fs.rm(workspaceDir, { recursive: true, force: true });
  });

  it("blocks commands not in allowlist", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "mozi-host-exec-"));
    let error: unknown;
    try {
      await hostExec({
        workspaceDir,
        command: "pwd",
        allowlist: ["ls"],
      });
    } catch (err) {
      error = err;
    }
    expect((error as Error | undefined)?.message).toContain("command not allowed: pwd");
    await fs.rm(workspaceDir, { recursive: true, force: true });
  });

  it("allows commands in allowlist", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "mozi-host-exec-"));
    const result = await hostExec({
      workspaceDir,
      command: "pwd",
      allowlist: ["pwd"],
    });
    expect(result.exitCode).toBe(0);
    await fs.rm(workspaceDir, { recursive: true, force: true });
  });

  it("allows commands with args when binary is allowlisted", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "mozi-host-exec-"));
    const result = await hostExec({
      workspaceDir,
      command: "ls -la",
      allowlist: ["ls"],
    });
    expect(result.exitCode).toBe(0);
    await fs.rm(workspaceDir, { recursive: true, force: true });
  });

  it("allows env-prefixed commands when binary is allowlisted", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "mozi-host-exec-"));
    const result = await hostExec({
      workspaceDir,
      command: "FOO=bar pwd",
      allowlist: ["pwd"],
    });
    expect(result.exitCode).toBe(0);
    await fs.rm(workspaceDir, { recursive: true, force: true });
  });

  it("blocks chained commands when any segment is not allowlisted", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "mozi-host-exec-"));
    let error: unknown;
    try {
      await hostExec({
        workspaceDir,
        command: "pwd && ls",
        allowlist: ["pwd"],
      });
    } catch (err) {
      error = err;
    }
    expect((error as Error | undefined)?.message).toContain("command not allowed: ls");
    await fs.rm(workspaceDir, { recursive: true, force: true });
  });
});
