import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildSandboxExecutorCacheKey, createSandboxExecutor } from "./executor";
import { SandboxService } from "./service";
import { VibeboxExecutor } from "./vibebox-executor";

describe("sandbox executor factory", () => {
  it("uses host executor for off mode", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "mozi-sbx-exec-"));
    const executor = createSandboxExecutor({
      config: { mode: "off" },
    });
    const result = await executor.exec({
      sessionKey: "s1",
      agentId: "a1",
      workspaceDir,
      command: "pwd",
    });
    expect(result.exitCode).toBe(0);
    const resolved = await fs.realpath(workspaceDir);
    expect(result.stdout.trim()).toBe(resolved);
    await fs.rm(workspaceDir, { recursive: true, force: true });
  });

  it("enforces allowlist in off mode", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "mozi-sbx-exec-"));
    const executor = createSandboxExecutor({
      config: { mode: "off" },
      allowlist: ["ls"],
    });
    let error: unknown;
    try {
      await executor.exec({
        sessionKey: "s1",
        agentId: "a1",
        workspaceDir,
        command: "pwd",
      });
    } catch (err) {
      error = err;
    }
    expect((error as Error | undefined)?.message).toContain("command not allowed: pwd");
    await fs.rm(workspaceDir, { recursive: true, force: true });
  });

  it("uses container executor for docker mode", () => {
    const executor = createSandboxExecutor({
      config: { mode: "docker", docker: { image: "img" } },
    });
    expect(executor).toBeInstanceOf(SandboxService);
  });

  it("uses container executor for apple-vm mode", () => {
    const executor = createSandboxExecutor({
      config: { mode: "apple-vm", apple: { image: "img" } },
    });
    expect(executor).toBeInstanceOf(SandboxService);
  });

  it("uses vibebox executor for apple-vm when backend is vibebox", () => {
    const executor = createSandboxExecutor({
      config: {
        mode: "apple-vm",
        apple: {
          backend: "vibebox",
          vibebox: { enabled: true },
        },
      },
    });
    expect(executor).toBeInstanceOf(VibeboxExecutor);
  });

  it("uses vibebox executor for docker mode when vibebox is enabled", () => {
    const executor = createSandboxExecutor({
      config: {
        mode: "docker",
        apple: {
          vibebox: { enabled: true },
        },
      },
    });
    expect(executor).toBeInstanceOf(VibeboxExecutor);
  });

  it("probe returns healthy for off mode", async () => {
    const executor = createSandboxExecutor({
      config: { mode: "off" },
    });
    const result = await executor.probe();
    expect(result.ok).toBe(true);
    expect(result.mode).toBe("off");
  });

  it("probe fails for docker mode when image is missing", async () => {
    const executor = createSandboxExecutor({
      config: { mode: "docker" },
    });
    const result = await executor.probe();
    expect(result.ok).toBe(false);
    expect(result.mode).toBe("docker");
    expect(result.message).toContain("missing docker.image");
  });
});

describe("sandbox executor cache key", () => {
  it("includes allowlist for off mode", () => {
    const a = buildSandboxExecutorCacheKey({
      config: { mode: "off" },
      allowlist: ["pwd"],
    });
    const b = buildSandboxExecutorCacheKey({
      config: { mode: "off" },
      allowlist: ["ls"],
    });
    expect(a).not.toBe(b);
  });

  it("uses config identity for container mode", () => {
    const a = buildSandboxExecutorCacheKey({
      config: { mode: "docker", docker: { image: "a" } },
      allowlist: ["pwd"],
    });
    const b = buildSandboxExecutorCacheKey({
      config: { mode: "docker", docker: { image: "a" } },
      allowlist: ["ls"],
    });
    expect(a).toBe(b);
  });

  it("uses vibebox identity for apple-vm vibebox mode", () => {
    const a = buildSandboxExecutorCacheKey({
      config: {
        mode: "apple-vm",
        apple: { backend: "vibebox", vibebox: { binPath: "/a" } },
      },
    });
    const b = buildSandboxExecutorCacheKey({
      config: {
        mode: "apple-vm",
        apple: { backend: "vibebox", vibebox: { binPath: "/b" } },
      },
    });
    expect(a).not.toBe(b);
  });

  it("uses vibebox identity for docker vibebox mode", () => {
    const a = buildSandboxExecutorCacheKey({
      config: {
        mode: "docker",
        apple: { vibebox: { binPath: "/a" } },
      },
    });
    const b = buildSandboxExecutorCacheKey({
      config: {
        mode: "docker",
        apple: { vibebox: { binPath: "/b" } },
      },
    });
    expect(a).not.toBe(b);
  });
});
