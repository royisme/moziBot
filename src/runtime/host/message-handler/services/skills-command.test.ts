import { describe, expect, it, vi } from "vitest";
import { handleSkillsCommand } from "./skills-command";

describe("handleSkillsCommand", () => {
  it("renders enabled and loaded-but-disabled sections", async () => {
    const send = vi.fn(async () => undefined);
    await handleSkillsCommand({
      agentId: "mozi",
      peerId: "peer-1",
      channel: { send },
      agentManager: {
        listSkillsInventory: async () => ({
          enabled: [{ name: "web-search", description: "Search web" }],
          loadedButDisabled: [{ name: "qmd", description: "Search markdown" }],
          missingConfigured: ["missing-skill"],
          allowlistActive: true,
        }),
      },
    });

    expect(send).toHaveBeenCalledWith(
      "peer-1",
      expect.objectContaining({
        text: expect.stringContaining("Skills: 1 enabled / 2 loaded"),
      }),
    );
    const payload = (send as ReturnType<typeof vi.fn>).mock.calls[0]?.[1];
    const text =
      payload && typeof payload === "object" && "text" in payload
        ? typeof (payload as { text?: unknown }).text === "string"
          ? ((payload as { text?: string }).text ?? "")
          : ""
        : "";
    expect(text).toContain("Enabled:");
    expect(text).toContain("• web-search - Search web");
    expect(text).toContain("Loaded but not enabled (1):");
    expect(text).toContain("• qmd");
    expect(text).toContain("Allowlist active");
    expect(text).toContain("Configured but not loaded: missing-skill");
  });

  it("falls back to listAvailableSkills when inventory is unavailable", async () => {
    const send = vi.fn(async () => undefined);
    await handleSkillsCommand({
      agentId: "mozi",
      peerId: "peer-1",
      channel: { send },
      agentManager: {
        listAvailableSkills: async () => [{ name: "web-search", description: "Search web" }],
      },
    });

    expect(send).toHaveBeenCalledWith(
      "peer-1",
      expect.objectContaining({
        text: expect.stringContaining("Skills: 1 enabled / 1 loaded"),
      }),
    );
    const payload = (send as ReturnType<typeof vi.fn>).mock.calls[0]?.[1];
    const text =
      payload && typeof payload === "object" && "text" in payload
        ? typeof (payload as { text?: unknown }).text === "string"
          ? ((payload as { text?: string }).text ?? "")
          : ""
        : "";
    expect(text).toContain("• web-search - Search web");
  });

  it("truncates disabled preview and long descriptions", async () => {
    const send = vi.fn(async () => undefined);
    const disabled = Array.from({ length: 11 }, (_, index) => ({
      name: `disabled-${index + 1}`,
      description: "x".repeat(200),
    }));
    await handleSkillsCommand({
      agentId: "mozi",
      peerId: "peer-1",
      channel: { send },
      agentManager: {
        listSkillsInventory: async () => ({
          enabled: [
            {
              name: "web-search",
              description:
                "Search the web via Tavily or Brave with exec and return concise source-backed output. Extra details that should be clipped in chat.",
            },
          ],
          loadedButDisabled: disabled,
          missingConfigured: ["a", "b", "c", "d", "e", "f", "g"],
          allowlistActive: true,
        }),
      },
    });

    const payload = (send as ReturnType<typeof vi.fn>).mock.calls[0]?.[1];
    const text =
      payload && typeof payload === "object" && "text" in payload
        ? typeof (payload as { text?: unknown }).text === "string"
          ? ((payload as { text?: string }).text ?? "")
          : ""
        : "";
    expect(text).toContain("Loaded but not enabled (11):");
    expect(text).toContain("• ...and 3 more");
    expect(text).toContain("Configured but not loaded: a, b, c, d, e, f (+1 more)");
    expect(text).toContain("• web-search - Search the web via Tavily or Brave with exec");
  });
});
