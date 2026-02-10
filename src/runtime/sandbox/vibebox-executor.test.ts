import { describe, expect, it } from "vitest";
import { VibeboxExecutor } from "./vibebox-executor";

describe("VibeboxExecutor", () => {
  it("probe returns unavailable when vibebox output is not json", async () => {
    const executor = new VibeboxExecutor({
      config: { binPath: "vibebox" },
      runCommand: async () => ({
        stdout: "not-json",
        stderr: "unknown command",
        exitCode: 1,
      }),
    });
    const result = await executor.probe();
    expect(result.ok).toBe(false);
    expect(result.message).toContain("unable to parse JSON");
  });

  it("probe returns available from vibebox diagnostics", async () => {
    const executor = new VibeboxExecutor({
      config: { binPath: "vibebox" },
      runCommand: async () => ({
        stdout: JSON.stringify({
          ok: true,
          selected: "apple-vm",
          diagnostics: {
            "apple-vm": {
              available: true,
              reason: "",
              fixHints: [],
            },
          },
        }),
        stderr: "",
        exitCode: 0,
      }),
    });
    const result = await executor.probe();
    expect(result.ok).toBe(true);
    expect(result.mode).toBe("apple-vm");
  });

  it("probe returns unavailable message from bridge error payload", async () => {
    const executor = new VibeboxExecutor({
      config: { binPath: "vibebox" },
      runCommand: async () => ({
        stdout: JSON.stringify({
          ok: false,
          selected: "apple-vm",
          error: "apple vm not available",
          diagnostics: {
            "apple-vm": {
              available: false,
              reason: "hypervisor missing",
              fixHints: ["enable virtualization"],
            },
          },
        }),
        stderr: "",
        exitCode: 1,
      }),
    });
    const result = await executor.probe();
    expect(result.ok).toBe(false);
    expect(result.message).toContain("apple vm not available");
    expect(result.hints).toContain("enable virtualization");
  });

  it("probe returns docker mode when selected backend is docker", async () => {
    const executor = new VibeboxExecutor({
      config: { binPath: "vibebox", provider: "auto" },
      runCommand: async () => ({
        stdout: JSON.stringify({
          ok: true,
          selected: "docker",
          diagnostics: {
            docker: {
              available: true,
            },
          },
        }),
        stderr: "",
        exitCode: 0,
      }),
    });
    const result = await executor.probe();
    expect(result.ok).toBe(true);
    expect(result.mode).toBe("docker");
  });

  it("probe returns off mode when selected backend is off", async () => {
    const executor = new VibeboxExecutor({
      config: { binPath: "vibebox", provider: "off" },
      runCommand: async () => ({
        stdout: JSON.stringify({
          ok: true,
          selected: "off",
          diagnostics: {
            off: {
              available: true,
            },
          },
        }),
        stderr: "",
        exitCode: 0,
      }),
    });
    const result = await executor.probe();
    expect(result.ok).toBe(true);
    expect(result.mode).toBe("off");
  });

  it("exec parses deterministic vibebox payload", async () => {
    const executor = new VibeboxExecutor({
      config: { binPath: "vibebox", timeoutSeconds: 30 },
      runCommand: async () => ({
        stdout: JSON.stringify({
          ok: true,
          stdout: "ok",
          stderr: "",
          exitCode: 0,
        }),
        stderr: "",
        exitCode: 0,
      }),
    });
    const result = await executor.exec({
      sessionKey: "s1",
      agentId: "a1",
      workspaceDir: "/tmp",
      command: "echo ok",
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("ok");
  });

  it("exec throws when bridge returns ok=false", async () => {
    const executor = new VibeboxExecutor({
      config: { binPath: "vibebox", timeoutSeconds: 30 },
      runCommand: async () => ({
        stdout: JSON.stringify({
          ok: false,
          selected: "apple-vm",
          error: "backend unavailable",
          diagnostics: {
            "apple-vm": {
              available: false,
              fixHints: ["install runtime"],
            },
          },
        }),
        stderr: "",
        exitCode: 2,
      }),
    });
    try {
      await executor.exec({
        sessionKey: "s1",
        agentId: "a1",
        workspaceDir: "/tmp",
        command: "echo ok",
      });
      throw new Error("expected vibebox executor to throw");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).toContain("backend unavailable");
    }
  });

  it("exec uses mode-derived default provider when provider is not configured", async () => {
    let capturedArgs: string[] = [];
    const executor = new VibeboxExecutor({
      config: { binPath: "vibebox", timeoutSeconds: 30 },
      defaultProvider: "docker",
      runCommand: async ({ args }) => {
        capturedArgs = args;
        return {
          stdout: JSON.stringify({
            ok: true,
            stdout: "ok",
            stderr: "",
            exitCode: 0,
          }),
          stderr: "",
          exitCode: 0,
        };
      },
    });
    await executor.exec({
      sessionKey: "s1",
      agentId: "a1",
      workspaceDir: "/tmp",
      command: "echo ok",
    });
    expect(capturedArgs).toContain("docker");
  });
});
