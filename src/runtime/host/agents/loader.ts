import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { AgentConfig } from "./types";
import { logger } from "../../../logger";
import { buildAgentSystemPrompt, loadAgentContextFiles } from "./context-builder";

export class AgentLoader {
  // Load agent config from workspace
  async loadFromWorkspace(workspacePath: string): Promise<Partial<AgentConfig>> {
    const configPaths = [join(workspacePath, "agent.json"), join(workspacePath, "mozi-agent.json")];

    for (const path of configPaths) {
      if (existsSync(path)) {
        try {
          const content = await readFile(path, "utf-8");
          return JSON.parse(content);
        } catch (error) {
          logger.error({ path, error }, "Failed to load agent config file");
        }
      }
    }

    return {};
  }

  // Load system prompt
  async loadSystemPrompt(agent: AgentConfig): Promise<string> {
    const contextFiles = await loadAgentContextFiles(agent.workspace, agent.contextFiles);

    // If there's an explicit system prompt path, load it and use it as the base prompt
    let basePrompt = agent.systemPrompt || "";
    if (agent.systemPromptPath) {
      const promptPath = resolve(agent.workspace, agent.systemPromptPath);
      try {
        basePrompt = await readFile(promptPath, "utf-8");
      } catch (error) {
        logger.warn({ path: promptPath, error }, "System prompt file not found");
      }
    }

    return buildAgentSystemPrompt({
      agentConfig: {
        ...agent,
        systemPrompt: basePrompt,
      },
      contextFiles,
    });
  }

  // Load context files (SOUL.md, TOOLS.md, etc.)
  async loadContextFiles(agent: AgentConfig): Promise<string[]> {
    const contextFiles = await loadAgentContextFiles(agent.workspace, agent.contextFiles);
    return contextFiles.map((f) => f.content);
  }
}
