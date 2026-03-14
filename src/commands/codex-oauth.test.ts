import { beforeEach, describe, expect, it, vi } from "vitest";

const { readCodexCliCredentials } = vi.hoisted(() => ({
  readCodexCliCredentials: vi.fn(),
}));

vi.mock("../runtime/cli-credentials", () => ({
  readCodexCliCredentials,
}));

describe("loginOpenAICodexOAuth", () => {
  beforeEach(() => {
    readCodexCliCredentials.mockReset();
    vi.restoreAllMocks();
  });

  it("returns existing Codex CLI credentials", async () => {
    readCodexCliCredentials.mockReturnValue({
      type: "oauth",
      provider: "openai-codex",
      access: "access-token",
      refresh: "refresh-token",
      expires: 123,
    });

    const { loginOpenAICodexOAuth } = await import("./codex-oauth");
    const result = await loginOpenAICodexOAuth({ baseDir: "/tmp/mozi", isRemote: true });

    expect(readCodexCliCredentials).toHaveBeenCalled();
    expect(result).toEqual({
      type: "oauth",
      provider: "openai-codex",
      access: "access-token",
      refresh: "refresh-token",
      expires: 123,
    });
  });

  it("prints guidance and returns null when credentials are missing", async () => {
    readCodexCliCredentials.mockReturnValue(null);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const { loginOpenAICodexOAuth } = await import("./codex-oauth");
    await expect(loginOpenAICodexOAuth()).resolves.toBeNull();

    expect(logSpy).toHaveBeenCalled();
  });
});
