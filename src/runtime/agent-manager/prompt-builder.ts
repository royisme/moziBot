import type { InboundMessage } from "../adapters/channels/types";
import type { SandboxConfig } from "../sandbox/types";
import type { SkillLoader } from "../../agents/skills/loader";
import {
  checkBootstrapState,
  loadHomeFiles,
  buildContextWithBootstrap,
  type BootstrapState,
} from "../../agents/home";
import { loadWorkspaceFiles, buildWorkspaceContext } from "../../agents/workspace";

export function buildChannelContext(message: InboundMessage): string {
  const lines: string[] = ["# Channel Context"];
  lines.push(`channel: ${message.channel}`);
  if (message.peerType) {
    lines.push(`peerType: ${message.peerType}`);
  } else {
    lines.push("peerType: dm");
  }
  if (message.peerId) {
    lines.push(`peerId: ${message.peerId}`);
  }
  if (message.accountId) {
    lines.push(`accountId: ${message.accountId}`);
  }
  if (message.threadId) {
    lines.push(`threadId: ${message.threadId}`);
  }
  if (message.senderId) {
    lines.push(`senderId: ${message.senderId}`);
  }
  if (message.senderName) {
    lines.push(`senderName: ${message.senderName}`);
  }
  if (message.timestamp instanceof Date) {
    lines.push(`timestamp: ${message.timestamp.toISOString()}`);
  }
  return lines.join("\n");
}

export function buildSandboxPrompt(params: {
  workspaceDir: string;
  sandboxConfig?: SandboxConfig;
}): string | null {
  const cfg = params.sandboxConfig;
  if (!cfg || cfg.mode === "off") {
    return null;
  }
  const modeLabel = cfg.mode === "apple-vm" ? "Apple VM" : "Docker";
  const lines = [
    "# Sandbox",
    `You are running in a sandboxed runtime (${modeLabel}).`,
    `Sandbox workspace: ${params.workspaceDir}`,
    cfg.workspaceAccess ? `Workspace access: ${cfg.workspaceAccess}` : "",
    "Home is the agent's identity store and may be updated outside the sandbox.",
    "All task output must be written to the workspace. Do not write task files into home.",
    "If you need host filesystem access outside workspace, ask the user first.",
  ].filter((line) => line && line.trim().length > 0);
  return lines.join("\n");
}

export function buildToolsSection(tools?: string[]): string | null {
  if (!tools || tools.length === 0) {
    return null;
  }
  const lines = ["# Tools", `Enabled tools: ${tools.join(", ")}`];
  return lines.join("\n");
}

export function buildSkillsSection(skillsPrompt: string, tools?: string[]): string {
  const canRecordNotes = tools?.includes("skills_note");
  const lines = [
    "# Skills",
    "Scan the available skills below and use the most relevant one.",
    "Before using a skill, check for local experience notes in home/skills/<skill>.md if present.",
    canRecordNotes ? "After using a skill, record key learnings with the skills_note tool." : "",
    skillsPrompt,
  ].filter((line) => line && line.trim().length > 0);
  return lines.join("\n");
}

export async function buildSystemPrompt(params: {
  homeDir: string;
  workspaceDir: string;
  basePrompt?: string;
  skills?: string[];
  tools?: string[];
  sandboxConfig?: SandboxConfig;
  skillLoader?: SkillLoader;
  skillsIndexSynced: Set<string>;
}): Promise<string> {
  // Check bootstrap state from home directory
  const bootstrapState = await checkBootstrapState(params.homeDir);

  // Load home files (agent identity)
  const homeFiles = await loadHomeFiles(params.homeDir);

  // Build home context with bootstrap instructions if needed
  const homeContext = buildContextWithBootstrap(homeFiles, bootstrapState);

  // Load workspace files (TOOLS.md)
  const workspaceFiles = await loadWorkspaceFiles(params.workspaceDir);
  const workspaceContext = buildWorkspaceContext(workspaceFiles, params.workspaceDir);

  let skillsPrompt = "";
  if (params.skillLoader) {
    await params.skillLoader.loadAll();
    if (!params.skillsIndexSynced.has(params.homeDir)) {
      await params.skillLoader.syncHomeIndex(params.homeDir);
      params.skillsIndexSynced.add(params.homeDir);
    }
    skillsPrompt = params.skillLoader.formatForPrompt(params.skills);
  }

  const sections: string[] = [];

  const sandboxNote = buildSandboxPrompt({
    workspaceDir: params.workspaceDir,
    sandboxConfig: params.sandboxConfig,
  });
  const toolsNote = buildToolsSection(params.tools);
  if (params.basePrompt) {
    sections.push(params.basePrompt);
  }

  // Add home context (identity + bootstrap if applicable)
  if (homeContext) {
    sections.push(`# Agent Identity\n${homeContext}`);
  }

  // Add workspace context
  if (workspaceContext) {
    sections.push(workspaceContext);
  }

  if (toolsNote) {
    sections.push(toolsNote);
  }

  if (sandboxNote) {
    sections.push(sandboxNote);
  }

  if (skillsPrompt) {
    sections.push(buildSkillsSection(skillsPrompt, params.tools));
  }

  return sections.join("\n\n");
}

export async function checkBootstrap(homeDir: string): Promise<BootstrapState> {
  return checkBootstrapState(homeDir);
}
