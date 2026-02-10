import { describe, expect, it, vi } from "vitest";
import { createExecTool } from "./tool";

describe("exec tool authRefs", () => {
  it("blocks protected API keys in plain env", async () => {
    const tool = createExecTool({
      executor: {
        exec: vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 })),
        stop: vi.fn(async () => {}),
        probe: vi.fn(async () => ({
          ok: true as const,
          mode: "off" as const,
          message: "ok",
          hints: [],
        })),
      },
      sessionKey: "s1",
      agentId: "mozi",
      workspaceDir: "/tmp",
      allowedSecrets: ["OPENAI_API_KEY"],
      authResolver: {
        getValue: vi.fn(async () => "secret"),
      },
    });

    const result = await tool.execute("id-1", {
      command: "pwd",
      env: { OPENAI_API_KEY: "raw" },
    });

    const text = (result.content?.[0] as { text?: string } | undefined)?.text ?? "";
    expect(text).toContain("Protected auth env vars are not allowed");
  });

  it("throws AUTH_MISSING when referenced secret is absent", async () => {
    const tool = createExecTool({
      executor: {
        exec: vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 })),
        stop: vi.fn(async () => {}),
        probe: vi.fn(async () => ({
          ok: true as const,
          mode: "off" as const,
          message: "ok",
          hints: [],
        })),
      },
      sessionKey: "s1",
      agentId: "mozi",
      workspaceDir: "/tmp",
      allowedSecrets: ["OPENAI_API_KEY"],
      authResolver: {
        getValue: vi.fn(async () => null),
      },
    });

    await expect(
      tool.execute("id-2", {
        command: "pwd",
        authRefs: ["OPENAI_API_KEY"],
      }),
    ).rejects.toThrow("AUTH_MISSING OPENAI_API_KEY");
  });

  it("returns disabled guidance when authRefs are used without auth resolver", async () => {
    const tool = createExecTool({
      executor: {
        exec: vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 })),
        stop: vi.fn(async () => {}),
        probe: vi.fn(async () => ({
          ok: true as const,
          mode: "off" as const,
          message: "ok",
          hints: [],
        })),
      },
      sessionKey: "s1",
      agentId: "mozi",
      workspaceDir: "/tmp",
      allowedSecrets: ["OPENAI_API_KEY"],
    });

    const result = await tool.execute("id-3", {
      command: "pwd",
      authRefs: ["OPENAI_API_KEY"],
    });

    const text = (result.content?.[0] as { text?: string } | undefined)?.text ?? "";
    expect(text).toContain("Auth broker is disabled for this runtime");
  });

  it("returns denied error when authRefs include non-allowed secret", async () => {
    const tool = createExecTool({
      executor: {
        exec: vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 })),
        stop: vi.fn(async () => {}),
        probe: vi.fn(async () => ({
          ok: true as const,
          mode: "off" as const,
          message: "ok",
          hints: [],
        })),
      },
      sessionKey: "s1",
      agentId: "mozi",
      workspaceDir: "/tmp",
      allowedSecrets: ["TAVILY_API_KEY"],
      authResolver: {
        getValue: vi.fn(async () => "secret"),
      },
    });

    const result = await tool.execute("id-4", {
      command: "pwd",
      authRefs: ["OPENAI_API_KEY"],
    });

    const text = (result.content?.[0] as { text?: string } | undefined)?.text ?? "";
    expect(text).toContain("Secret(s) not allowed for this agent");
  });
});
