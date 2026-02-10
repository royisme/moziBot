import fs from "node:fs/promises";
import path from "node:path";
import type { AgentConfig } from "./types";

export interface EmbeddedContextFile {
  path: string;
  content: string;
}

/**
 * Loads context files (like SOUL.md, TOOLS.md) from an agent's workspace.
 */
export async function loadAgentContextFiles(
  workspaceDir: string,
  explicitFiles?: string[],
): Promise<EmbeddedContextFile[]> {
  const filesToLoad = explicitFiles || ["SOUL.md", "TOOLS.md", "USER.md"];
  const result: EmbeddedContextFile[] = [];

  for (const fileName of filesToLoad) {
    const filePath = path.isAbsolute(fileName) ? fileName : path.join(workspaceDir, fileName);

    try {
      const content = await fs.readFile(filePath, "utf-8");
      result.push({
        path: path.basename(filePath),
        content,
      });
    } catch (err) {
      // Skip if file doesn't exist
      if ((err as { code?: string }).code !== "ENOENT") {
        throw err;
      }
    }
  }

  return result;
}

export interface SystemPromptParams {
  agentConfig: AgentConfig;
  contextFiles: EmbeddedContextFile[];
  currentTime?: Date;
  timezone?: string;
}

/**
 * Builds the system prompt for an agent, combining identity, tools, and context files.
 */
export function buildAgentSystemPrompt(params: SystemPromptParams): string {
  const { agentConfig, contextFiles, currentTime = new Date(), timezone = "UTC" } = params;

  const lines: string[] = [];

  // 1. Core Identity
  lines.push(`# Identity: ${agentConfig.name || agentConfig.id}`);
  if (agentConfig.systemPrompt) {
    lines.push(agentConfig.systemPrompt);
  }
  lines.push("");

  // 2. Runtime Info
  lines.push("## Runtime");
  lines.push(`- Current Time: ${currentTime.toISOString()} (${timezone})`);
  lines.push(`- Workspace: ${agentConfig.workspace}`);
  lines.push("");

  // 3. Tools & Skills
  if (agentConfig.tools?.length || agentConfig.skills?.length) {
    lines.push("## Capabilities");
    if (agentConfig.tools?.length) {
      lines.push(`- Enabled Tools: ${agentConfig.tools.join(", ")}`);
    }
    if (agentConfig.skills?.length) {
      lines.push(`- Loaded Skills: ${agentConfig.skills.join(", ")}`);
    }
    lines.push("");
  }

  // 4. Project Context (SOUL.md, etc)
  if (contextFiles.length > 0) {
    lines.push("# Project Context");
    lines.push("The following context files have been loaded from your workspace:");
    lines.push("");

    for (const file of contextFiles) {
      lines.push(`## ${file.path}`);
      lines.push(file.content);
      lines.push("");
    }
  }

  // 5. Instruction Safety (Simplified OpenClaw version)
  lines.push("## Instructions");
  lines.push("- Be concise and helpful.");
  lines.push("- If SOUL.md is present, embody its persona and tone.");
  lines.push("- Use the tools provided to fulfill requests.");

  return lines.join("\n").trim();
}
