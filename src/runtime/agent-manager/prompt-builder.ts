import { createHash } from "node:crypto";
import type { SkillLoader } from "../../agents/skills/loader";
import type { InboundMessage } from "../adapters/channels/types";
import type { SandboxConfig } from "../sandbox/types";
import {
  checkBootstrapState,
  loadHomeFiles,
  type BootstrapState,
  type HomeFile,
} from "../../agents/home";
import {
  loadWorkspaceFiles,
  buildWorkspaceContext,
  type WorkspaceFile,
} from "../../agents/workspace";
import { sanitizePromptLiteral } from "../../security/prompt-literal";
import { SILENT_REPLY_TOKEN } from "../host/reply-utils";

export function buildChannelContext(message: InboundMessage): string {
  const lines: string[] = ["# Channel Context"];
  lines.push(`channel: ${sanitizePromptLiteral(message.channel)}`);
  if (message.peerType) {
    lines.push(`peerType: ${sanitizePromptLiteral(message.peerType)}`);
  } else {
    lines.push("peerType: dm");
  }
  if (message.peerId) {
    lines.push(`peerId: ${sanitizePromptLiteral(message.peerId)}`);
  }
  if (message.accountId) {
    lines.push(`accountId: ${sanitizePromptLiteral(message.accountId)}`);
  }
  if (message.threadId) {
    lines.push(`threadId: ${sanitizePromptLiteral(message.threadId)}`);
  }
  if (message.senderId) {
    lines.push(`senderId: ${sanitizePromptLiteral(message.senderId)}`);
  }
  if (message.senderName) {
    lines.push(`senderName: ${sanitizePromptLiteral(message.senderName)}`);
  }
  if (message.timestamp instanceof Date) {
    lines.push(`timestamp: ${sanitizePromptLiteral(message.timestamp.toISOString())}`);
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
  const safeWorkspaceDir = sanitizePromptLiteral(params.workspaceDir);
  const safeWorkspaceAccess = cfg.workspaceAccess
    ? sanitizePromptLiteral(cfg.workspaceAccess)
    : null;
  const lines = [
    "# Sandbox",
    `You are running in a sandboxed runtime (${modeLabel}).`,
    `Sandbox workspace: ${safeWorkspaceDir}`,
    safeWorkspaceAccess ? `Workspace access: ${safeWorkspaceAccess}` : "",
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
  const safeTools = tools.map((tool) => sanitizePromptLiteral(tool));
  const lines = ["# Tools", `Enabled tools: ${safeTools.join(", ")}`];
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

function buildPromptPrecedenceContract(): string {
  const lines = [
    "# Prompt Precedence",
    "Resolve instructions in this order:",
    "1) Core Constraints and Safety",
    "2) Identity & Persona (SOUL.md, IDENTITY.md, USER.md, MEMORY.md)",
    "3) Project & Workspace Rules (AGENTS.md, workspace docs, HEARTBEAT.md)",
    "4) Runtime Context and tooling notes",
    "If two instructions conflict within the same layer, prefer the more specific one.",
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
  const sections: string[] = [
    "# Identity & Persona",
    "These files are authoritative for your identity, tone, language, and user relationship.",
    "Treat identity as behavioral operating state, not decoration.",
    "When introducing yourself or speaking about role, derive it from these files.",
    "Use USER.md preferences for language and communication style unless safety or project rules require otherwise.",
  ];

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

export type PromptMode = "main" | "reset-greeting" | "subagent-minimal";

export interface PromptBuildMetadata {
  mode: PromptMode;
  homeDir: string;
  workspaceDir: string;
  loadedFiles: Array<{ name: string; chars: number }>;
  skippedFiles: Array<{ name: string; reason: "missing" | "empty" }>;
  promptHash: string;
}

function collectFileObservability(params: {
  homeFiles: HomeFile[];
  workspaceFiles: WorkspaceFile[];
}): Pick<PromptBuildMetadata, "loadedFiles" | "skippedFiles"> {
  const loadedFiles: Array<{ name: string; chars: number }> = [];
  const skippedFiles: Array<{ name: string; reason: "missing" | "empty" }> = [];

  for (const file of params.homeFiles) {
    if (file.missing) {
      skippedFiles.push({ name: file.name, reason: "missing" });
      continue;
    }
    const content = file.content.trim();
    if (!content) {
      skippedFiles.push({ name: file.name, reason: "empty" });
      continue;
    }
    loadedFiles.push({ name: file.name, chars: content.length });
  }

  for (const file of params.workspaceFiles) {
    if (file.missing) {
      skippedFiles.push({ name: file.name, reason: "missing" });
      continue;
    }
    const content = file.content.trim();
    if (!content) {
      skippedFiles.push({ name: file.name, reason: "empty" });
      continue;
    }
    loadedFiles.push({ name: file.name, chars: content.length });
  }

  return { loadedFiles, skippedFiles };
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
  mode?: PromptMode;
  onMetadata?: (metadata: PromptBuildMetadata) => void;
}): Promise<string> {
  const mode = params.mode ?? "main";
  const bootstrapState = await checkBootstrapState(params.homeDir);
  const homeFiles = await loadHomeFiles(params.homeDir);
  const homeIndex = indexHomeFiles(homeFiles);

  const workspaceFiles = await loadWorkspaceFiles(params.workspaceDir);
  const workspaceContext = buildWorkspaceContext(workspaceFiles, params.workspaceDir);

  if (mode === "subagent-minimal") {
    for (const key of ["SOUL.md", "IDENTITY.md", "USER.md", "MEMORY.md", "HEARTBEAT.md"]) {
      homeIndex.delete(key);
    }
  }

  if (mode === "reset-greeting") {
    homeIndex.delete("MEMORY.md");
  }

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
  sections.push(buildPromptPrecedenceContract());

  if (params.basePrompt?.trim()) {
    sections.push("# Runtime Base Prompt\n" + params.basePrompt.trim());
  }

  const identityPersona = buildIdentityPersona({ homeIndex });
  if (identityPersona) {
    sections.push(identityPersona);
  }

  const projectWorkspace = buildProjectWorkspaceRules({ homeIndex, workspaceContext });
  if (projectWorkspace) {
    sections.push(projectWorkspace);
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

  const promptText = sections.join("\n\n");
  if (params.onMetadata) {
    const filesMeta = collectFileObservability({ homeFiles, workspaceFiles });
    params.onMetadata({
      mode,
      homeDir: params.homeDir,
      workspaceDir: params.workspaceDir,
      loadedFiles: filesMeta.loadedFiles,
      skippedFiles: filesMeta.skippedFiles,
      promptHash: createHash("sha256").update(promptText).digest("hex").slice(0, 12),
    });
  }

  return promptText;
}

export async function checkBootstrap(homeDir: string): Promise<BootstrapState> {
  return checkBootstrapState(homeDir);
}
