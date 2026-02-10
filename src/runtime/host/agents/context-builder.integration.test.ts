import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test, describe, beforeAll, afterAll } from "vitest";
import { buildAgentSystemPrompt, loadAgentContextFiles } from "./context-builder";

describe("Agent Context Builder", () => {
  let tempDir: string;

  beforeAll(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "mozi-test-"));
    await fs.writeFile(path.join(tempDir, "SOUL.md"), "Be a helpful robot.");
    await fs.writeFile(path.join(tempDir, "TOOLS.md"), "Use tools wisely.");
  });

  afterAll(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test("loadAgentContextFiles loads SOUL.md and TOOLS.md", async () => {
    const contextFiles = await loadAgentContextFiles(tempDir);
    expect(contextFiles).toHaveLength(2);
    expect(contextFiles.find((f) => f.path === "SOUL.md")?.content).toBe("Be a helpful robot.");
    expect(contextFiles.find((f) => f.path === "TOOLS.md")?.content).toBe("Use tools wisely.");
  });

  test("buildAgentSystemPrompt combines components", () => {
    const prompt = buildAgentSystemPrompt({
      agentConfig: {
        id: "test-agent",
        name: "Test Agent",
        workspace: "/tmp/workspace",
        systemPrompt: "Base prompt instruction.",
        tools: ["test_tool"],
      },
      contextFiles: [{ path: "SOUL.md", content: "Be a helpful robot." }],
    });

    expect(prompt).toContain("# Identity: Test Agent");
    expect(prompt).toContain("Base prompt instruction.");
    expect(prompt).toContain("- Enabled Tools: test_tool");
    expect(prompt).toContain("# Project Context");
    expect(prompt).toContain("## SOUL.md");
    expect(prompt).toContain("Be a helpful robot.");
    expect(prompt).toContain("If SOUL.md is present, embody its persona and tone.");
  });
});
