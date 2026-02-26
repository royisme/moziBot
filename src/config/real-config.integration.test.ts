import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveTemplatePath } from "../agents/templates";
import { resolveHomeDir, resolveWorkspaceDir } from "../runtime/agent-manager/config-resolver";
import { buildSystemPrompt } from "../runtime/agent-manager/prompt-builder";
import { loadConfig } from "./loader";

const REAL_CONFIG_ENV = "MOZI_REAL_CONFIG_TEST";
const REAL_CONFIG_PATH_ENV = "MOZI_REAL_CONFIG_PATH";

function getRealConfigPath(): string {
  return process.env[REAL_CONFIG_PATH_ENV] || path.join(os.homedir(), ".mozi", "config.jsonc");
}

function pickMainAgentId(agents: Record<string, unknown> | undefined): string {
  if (!agents) {
    return "mozi";
  }
  for (const [id, entry] of Object.entries(agents)) {
    if (id === "defaults") {
      continue;
    }
    if (entry && typeof entry === "object" && (entry as { main?: boolean }).main === true) {
      return id;
    }
  }
  const fallback = Object.keys(agents).find((id) => id !== "defaults");
  return fallback || "mozi";
}

const configPath = getRealConfigPath();
const shouldRun =
  process.env[REAL_CONFIG_ENV] === "1" && configPath.length > 0 && fs.existsSync(configPath);

const run = shouldRun ? it : it.skip;

describe("real config integration (no mocks)", () => {
  run("loads local config and builds system prompt using real paths", async () => {
    const result = loadConfig(configPath);
    expect(result.success).toBe(true);
    const config = result.config!;
    const agents = config.agents as Record<string, unknown> | undefined;
    const agentId = pickMainAgentId(agents);
    const entry = agents?.[agentId] as { home?: string; workspace?: string } | undefined;

    const homeDir = resolveHomeDir(config, agentId, entry);
    const workspaceDir = resolveWorkspaceDir(config, agentId, entry);

    expect(homeDir).toBeTruthy();
    expect(workspaceDir).toBeTruthy();

    const templatePath = resolveTemplatePath("IDENTITY.md");
    expect(templatePath).toBeTruthy();
    if (templatePath) {
      expect(fs.existsSync(templatePath)).toBe(true);
    }

    const prompt = await buildSystemPrompt({
      homeDir,
      workspaceDir,
      skillsIndexSynced: new Set<string>(),
    });

    expect(prompt).toContain(`Home directory: ${homeDir}`);
    expect(prompt).toContain(`Workspace directory: ${workspaceDir}`);
  });
});
