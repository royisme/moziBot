import { writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { AgentLoader } from "./loader";
import { AgentConfig } from "./types";

describe("AgentLoader", () => {
  let loader: AgentLoader;
  let tempDir: string;

  beforeEach(async () => {
    loader = new AgentLoader();
    tempDir = join(tmpdir(), `mozi-test-${Date.now()}`);
    await mkdir(tempDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("should load config from agent.json", async () => {
    const agentConfig = { id: "test-agent", name: "Test Agent" };
    await writeFile(join(tempDir, "agent.json"), JSON.stringify(agentConfig));

    const loaded = await loader.loadFromWorkspace(tempDir);
    expect(loaded.id).toBe("test-agent");
    expect(loaded.name).toBe("Test Agent");
  });

  it("should load config from mozi-agent.json", async () => {
    const agentConfig = { id: "test-agent-mozi", name: "Mozi Agent" };
    await writeFile(join(tempDir, "mozi-agent.json"), JSON.stringify(agentConfig));

    const loaded = await loader.loadFromWorkspace(tempDir);
    expect(loaded.id).toBe("test-agent-mozi");
    expect(loaded.name).toBe("Mozi Agent");
  });

  it("should load system prompt from file and append context files", async () => {
    await mkdir(join(tempDir, "prompts"), { recursive: true });
    await writeFile(join(tempDir, "prompts/system.md"), "Base system prompt");
    await writeFile(join(tempDir, "SOUL.md"), "Soul content");
    await writeFile(join(tempDir, "TOOLS.md"), "Tools content");

    const agent: AgentConfig = {
      id: "test",
      workspace: tempDir,
      systemPromptPath: "prompts/system.md",
      contextFiles: ["SOUL.md", "TOOLS.md"],
    };

    const prompt = await loader.loadSystemPrompt(agent);
    expect(prompt).toContain("Base system prompt");
    expect(prompt).toContain("Soul content");
    expect(prompt).toContain("Tools content");
  });

  it("should use inline system prompt if path is not provided", async () => {
    const agent: AgentConfig = {
      id: "test",
      workspace: tempDir,
      systemPrompt: "Inline prompt",
    };

    const prompt = await loader.loadSystemPrompt(agent);
    expect(prompt).toContain("Inline prompt");
  });

  it("should load context files", async () => {
    await writeFile(join(tempDir, "file1.md"), "Content 1");
    await writeFile(join(tempDir, "file2.md"), "Content 2");

    const agent: AgentConfig = {
      id: "test",
      workspace: tempDir,
      contextFiles: ["file1.md", "file2.md"],
    };

    const contents = await loader.loadContextFiles(agent);
    expect(contents).toHaveLength(2);
    expect(contents).toContain("Content 1");
    expect(contents).toContain("Content 2");
  });
});
