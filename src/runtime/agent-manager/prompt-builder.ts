import type { SkillLoader } from "../../agents/skills/loader";
import type { InboundMessage } from "../adapters/channels/types";
import type { SandboxConfig } from "../sandbox/types";
import {
  checkBootstrapState,
  loadHomeFiles,
  type BootstrapState,
  type HomeFile,
} from "../../agents/home";
import { loadWorkspaceFiles, buildWorkspaceContext } from "../../agents/workspace";
import { SILENT_REPLY_TOKEN } from "../host/reply-utils";

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

function buildWorkAssistantContract(): string {
  const lines = [
    "# Core Constraints",
    "You are a work assistant, not a chatbot.",
    "Be concise and useful. Avoid filler phrases and performative politeness.",
    "Prefer tool execution and concrete actions over generic discussion.",
    "If no outbound reply is needed, return the exact token NO_REPLY.",
    `Silent token: ${SILENT_REPLY_TOKEN}`,
    "When constraints conflict, prioritize safety and project/workspace rules over style.",
  ];
  return lines.join("\n");
}

function indexHomeFiles(files: HomeFile[]): Map<string, string> {
  const index = new Map<string, string>();
  for (const file of files) {
    if (file.missing) {
      continue;
    }
    const content = file.content.trim();
    if (!content) {
      continue;
    }
    index.set(file.name, content);
  }
  return index;
}

function buildProjectWorkspaceRules(params: {
  homeIndex: Map<string, string>;
  workspaceContext: string;
}): string | null {
  const sections: string[] = ["# Project & Workspace Rules"];

  const agents = params.homeIndex.get("AGENTS.md");
  if (agents) {
    sections.push("## AGENTS.md", agents);
  }

  if (params.workspaceContext.trim()) {
    sections.push(params.workspaceContext);
  }

  const heartbeat = params.homeIndex.get("HEARTBEAT.md");
  if (heartbeat) {
    sections.push("## HEARTBEAT.md", heartbeat);
  }

  return sections.length > 1 ? sections.join("\n\n") : null;
}

function buildIdentityPersona(params: { homeIndex: Map<string, string> }): string | null {
  const sections: string[] = ["# Identity & Persona"];

  const orderedFiles = ["SOUL.md", "IDENTITY.md", "USER.md", "MEMORY.md"] as const;
  for (const fileName of orderedFiles) {
    const content = params.homeIndex.get(fileName);
    if (!content) {
      continue;
    }
    sections.push(`## ${fileName}`, content);
  }

  return sections.length > 1 ? sections.join("\n\n") : null;
}

function buildBootstrapSection(bootstrapState: BootstrapState): string | null {
  if (!bootstrapState.isBootstrapping || !bootstrapState.bootstrapContent?.trim()) {
    return null;
  }

  const lines = [
    "# Bootstrap Mode",
    bootstrapState.bootstrapContent.trim(),
    "IMPORTANT: Complete bootstrap and then call complete_bootstrap.",
  ];

  return lines.join("\n\n");
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
  const bootstrapState = await checkBootstrapState(params.homeDir);
  const homeFiles = await loadHomeFiles(params.homeDir);
  const homeIndex = indexHomeFiles(homeFiles);

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

  sections.push(buildWorkAssistantContract());

  if (params.basePrompt?.trim()) {
    sections.push("# Runtime Base Prompt\n" + params.basePrompt.trim());
  }

  const projectWorkspace = buildProjectWorkspaceRules({ homeIndex, workspaceContext });
  if (projectWorkspace) {
    sections.push(projectWorkspace);
  }

  const identityPersona = buildIdentityPersona({ homeIndex });
  if (identityPersona) {
    sections.push(identityPersona);
  }

  const runtimeContextParts: string[] = [];
  const bootstrapNote = buildBootstrapSection(bootstrapState);
  if (bootstrapNote) {
    runtimeContextParts.push(bootstrapNote);
  }
  const toolsNote = buildToolsSection(params.tools);
  if (toolsNote) {
    runtimeContextParts.push(toolsNote);
  }
  const sandboxNote = buildSandboxPrompt({
    workspaceDir: params.workspaceDir,
    sandboxConfig: params.sandboxConfig,
  });
  if (sandboxNote) {
    runtimeContextParts.push(sandboxNote);
  }
  if (runtimeContextParts.length > 0) {
    sections.push("# Runtime Context\n\n" + runtimeContextParts.join("\n\n"));
  }

  if (skillsPrompt) {
    sections.push(buildSkillsSection(skillsPrompt, params.tools));
  }

  return sections.join("\n\n");
}

export async function checkBootstrap(homeDir: string): Promise<BootstrapState> {
  return checkBootstrapState(homeDir);
}
