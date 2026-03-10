import { createHash } from "node:crypto";
import { checkBootstrapState, loadHomeFiles, type BootstrapState } from "../../agents/home";
import type { SkillLoader } from "../../agents/skills/loader";
import { loadWorkspaceFiles } from "../../agents/workspace";
import { sanitizePromptLiteral } from "../../security/prompt-literal";
import type { CurrentChannelContext, InboundMessage } from "../adapters/channels/types";
import { SILENT_REPLY_TOKEN } from "../host/reply-utils";
import type { SandboxConfig } from "../sandbox/types";

export function buildChannelContext(
  message: InboundMessage,
  currentChannel?: CurrentChannelContext,
  registeredTools?: string[],
): string {
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
  if (message.threadId !== undefined) {
    lines.push(`threadId: ${sanitizePromptLiteral(String(message.threadId))}`);
  }
  if (message.replyToId !== undefined) {
    lines.push(`replyToId: ${sanitizePromptLiteral(String(message.replyToId))}`);
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
  if (currentChannel) {
    lines.push(`sessionKey: ${sanitizePromptLiteral(currentChannel.sessionKey ?? "")}`);
    const effectiveActions = currentChannel.allowedActions.filter((action) => {
      if (action === "send_media") {
        return registeredTools?.includes("send_media") ?? false;
      }
      return true;
    });
    lines.push(
      `allowedActions: ${effectiveActions.map((a) => sanitizePromptLiteral(a)).join(", ")}`,
    );
    if (effectiveActions.includes("send_media")) {
      lines.push(
        "When send_media is listed, use the send_media tool with a local filePath — do not search for tokens or scripts.",
      );
    }
    lines.push(`supportsMedia: ${currentChannel.capabilities.media}`);
    lines.push(`supportsPolls: ${currentChannel.capabilities.polls}`);
    lines.push(`supportsReactions: ${currentChannel.capabilities.reactions}`);
    lines.push(`supportsThreads: ${currentChannel.capabilities.threads}`);
    lines.push(`supportsEditMessage: ${currentChannel.capabilities.editMessage}`);
    lines.push(`supportsDeleteMessage: ${currentChannel.capabilities.deleteMessage}`);
    lines.push(`implicitCurrentTarget: ${currentChannel.capabilities.implicitCurrentTarget}`);
    lines.push(
      `defaultTarget.peerId: ${sanitizePromptLiteral(currentChannel.defaultTarget.peerId)}`,
    );
    if (currentChannel.defaultTarget.threadId) {
      lines.push(
        `defaultTarget.threadId: ${sanitizePromptLiteral(currentChannel.defaultTarget.threadId)}`,
      );
    }
    if (currentChannel.defaultTarget.replyToId) {
      lines.push(
        `defaultTarget.replyToId: ${sanitizePromptLiteral(currentChannel.defaultTarget.replyToId)}`,
      );
    }
    if (currentChannel.capabilities.maxTextLength !== undefined) {
      lines.push(
        `maxTextLength: ${sanitizePromptLiteral(String(currentChannel.capabilities.maxTextLength))}`,
      );
    }
    if (currentChannel.capabilities.maxCaptionLength !== undefined) {
      lines.push(
        `maxCaptionLength: ${sanitizePromptLiteral(String(currentChannel.capabilities.maxCaptionLength))}`,
      );
    }
  }
  lines.push(
    "Default delivery contract: your normal reply text is automatically delivered back to this same channel, peer, and thread when present.",
  );
  lines.push(
    "When the current channel advertises send_media or other actions, you may use them without re-asking for the current peerId/threadId; the runtime fills the current target automatically.",
  );
  lines.push(
    "Do not ask the user how to send the reply, do not search for bot tokens, and do not look for CLI/scripts just to answer in the current conversation.",
  );
  lines.push(
    "Only ask for an explicit target when the user wants delivery to a different destination than the current conversation.",
  );
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

export function buildRuntimePathsPrompt(params: { homeDir: string; workspaceDir: string }): string {
  const safeHomeDir = sanitizePromptLiteral(params.homeDir);
  const safeWorkspaceDir = sanitizePromptLiteral(params.workspaceDir);
  const lines = [
    "# Runtime Paths",
    `Home directory: ${safeHomeDir}`,
    `Workspace directory: ${safeWorkspaceDir}`,
    "Home is the agent's identity store; write task output only to the workspace.",
  ];
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
    "2) Bootstrap (BOOTSTRAP.md) when present",
    "3) Agent Behavior (AGENTS.md)",
    "4) Identity & Persona (SOUL.md, IDENTITY.md, USER.md, MEMORY.md)",
    "5) Heartbeat (HEARTBEAT.md)",
    "6) Workspace Rules (WORK.md, TOOLS.md)",
    "7) Runtime Context and tooling notes",
    "If two instructions conflict within the same layer, prefer the more specific one.",
  ];
  return lines.join("\n");
}

type ContextFile = {
  name: string;
  path: string;
  content: string;
  missing: boolean;
};

const DEFAULT_CONTEXT_MAX_CHARS = 20_000;
const DEFAULT_CONTEXT_TOTAL_MAX_CHARS = 150_000;
const CONTEXT_HEAD_RATIO = 0.7;
const CONTEXT_TAIL_RATIO = 0.2;

type TrimContextResult = {
  content: string;
  truncated: boolean;
  maxChars: number;
  originalLength: number;
};

function hashPromptContent(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 12);
}

function trimContextContent(
  content: string,
  fileName: string,
  maxChars: number,
): TrimContextResult {
  const trimmed = content.trimEnd();
  if (trimmed.length <= maxChars) {
    return {
      content: trimmed,
      truncated: false,
      maxChars,
      originalLength: trimmed.length,
    };
  }

  const headChars = Math.floor(maxChars * CONTEXT_HEAD_RATIO);
  const tailChars = Math.floor(maxChars * CONTEXT_TAIL_RATIO);
  const head = trimmed.slice(0, headChars);
  const tail = trimmed.slice(-tailChars);
  const marker = [
    "",
    `[...truncated, read ${fileName} for full content...]`,
    `(truncated ${fileName}: kept ${headChars}+${tailChars} chars of ${trimmed.length})`,
    "",
  ].join("\n");
  return {
    content: [head, marker, tail].join("\n"),
    truncated: true,
    maxChars,
    originalLength: trimmed.length,
  };
}

function clampToBudget(content: string, budget: number): string {
  if (budget <= 0) {
    return "";
  }
  if (content.length <= budget) {
    return content;
  }
  if (budget <= 3) {
    return content.slice(0, budget);
  }
  return `${content.slice(0, budget - 3)}...`;
}

function buildContextFileSection(params: {
  file: ContextFile | undefined;
  remainingTotalChars: number;
  maxChars: number;
  observability?: {
    loadedFiles: Array<{ name: string; chars: number; hash: string }>;
    skippedFiles: Array<{ name: string; reason: "missing" | "empty" }>;
  };
}): { section: string | null; remainingTotalChars: number } {
  const { file } = params;
  if (!file) {
    return { section: null, remainingTotalChars: params.remainingTotalChars };
  }
  const recordSkipped = (reason: "missing" | "empty") => {
    params.observability?.skippedFiles.push({ name: file.name, reason });
  };
  const header = `## ${file.name}`;
  const headerLength = header.length + 2;
  if (params.remainingTotalChars <= headerLength) {
    if (file.missing) {
      recordSkipped("missing");
    } else if (!file.content.trim()) {
      recordSkipped("empty");
    }
    return { section: null, remainingTotalChars: params.remainingTotalChars };
  }

  let body = file.missing ? `[MISSING] Expected at: ${file.path}` : file.content.trim();

  if (!body) {
    recordSkipped(file.missing ? "missing" : "empty");
    return { section: null, remainingTotalChars: params.remainingTotalChars };
  }

  if (!file.missing) {
    const trimmed = trimContextContent(body, file.name, params.maxChars);
    body = trimmed.content;
  }

  const available = params.remainingTotalChars - headerLength;
  body = clampToBudget(body, available);
  if (!body) {
    recordSkipped(file.missing ? "missing" : "empty");
    return { section: null, remainingTotalChars: params.remainingTotalChars };
  }

  const section = `${header}\n\n${body}`;
  const nextRemaining = Math.max(0, params.remainingTotalChars - section.length);
  if (file.missing) {
    recordSkipped("missing");
  } else {
    params.observability?.loadedFiles.push({
      name: file.name,
      chars: body.length,
      hash: hashPromptContent(body),
    });
  }
  return { section, remainingTotalChars: nextRemaining };
}

function findContextFile(files: ContextFile[], name: string): ContextFile | undefined {
  return files.find((file) => file.name === name);
}

function buildAgentBehaviorSection(params: {
  homeFiles: ContextFile[];
  remainingTotalChars: number;
  maxChars: number;
  observability?: {
    loadedFiles: Array<{ name: string; chars: number; hash: string }>;
    skippedFiles: Array<{ name: string; reason: "missing" | "empty" }>;
  };
}): { section: string | null; remainingTotalChars: number } {
  const result = buildContextFileSection({
    file: findContextFile(params.homeFiles, "AGENTS.md"),
    remainingTotalChars: params.remainingTotalChars,
    maxChars: params.maxChars,
    observability: params.observability,
  });
  if (!result.section) {
    return { section: null, remainingTotalChars: result.remainingTotalChars };
  }
  return {
    section: ["# Agent Behavior", result.section].join("\n\n"),
    remainingTotalChars: result.remainingTotalChars,
  };
}

function buildIdentityPersonaSection(params: {
  homeFiles: ContextFile[];
  remainingTotalChars: number;
  maxChars: number;
  mode: PromptMode;
  observability?: {
    loadedFiles: Array<{ name: string; chars: number; hash: string }>;
    skippedFiles: Array<{ name: string; reason: "missing" | "empty" }>;
  };
}): { section: string | null; remainingTotalChars: number } {
  if (params.mode === "subagent-minimal") {
    return { section: null, remainingTotalChars: params.remainingTotalChars };
  }

  const sections: string[] = [
    "# Identity & Persona",
    "These files are authoritative for your identity, tone, language, and user relationship.",
    "Treat identity as behavioral operating state, not decoration.",
    "When introducing yourself or speaking about role, derive it from these files.",
    "Use USER.md preferences for language and communication style unless safety or agent rules require otherwise.",
    "If USER.md exists and is non-empty, do not claim you lack the user's identity or preferences. Use USER.md as the source of truth.",
  ];

  let remainingTotalChars = params.remainingTotalChars;
  const orderedFiles =
    params.mode === "reset-greeting"
      ? (["SOUL.md", "IDENTITY.md", "USER.md"] as const)
      : (["SOUL.md", "IDENTITY.md", "USER.md", "MEMORY.md"] as const);

  for (const fileName of orderedFiles) {
    const result = buildContextFileSection({
      file: findContextFile(params.homeFiles, fileName),
      remainingTotalChars,
      maxChars: params.maxChars,
      observability: params.observability,
    });
    if (result.section) {
      sections.push(result.section);
      remainingTotalChars = result.remainingTotalChars;
    }
  }

  if (sections.length <= 1) {
    return { section: null, remainingTotalChars };
  }

  return { section: sections.join("\n\n"), remainingTotalChars };
}

function buildHeartbeatSection(params: {
  homeFiles: ContextFile[];
  remainingTotalChars: number;
  maxChars: number;
  mode: PromptMode;
  observability?: {
    loadedFiles: Array<{ name: string; chars: number; hash: string }>;
    skippedFiles: Array<{ name: string; reason: "missing" | "empty" }>;
  };
}): { section: string | null; remainingTotalChars: number } {
  if (params.mode === "subagent-minimal") {
    return { section: null, remainingTotalChars: params.remainingTotalChars };
  }

  const result = buildContextFileSection({
    file: findContextFile(params.homeFiles, "HEARTBEAT.md"),
    remainingTotalChars: params.remainingTotalChars,
    maxChars: params.maxChars,
    observability: params.observability,
  });
  if (!result.section) {
    return { section: null, remainingTotalChars: result.remainingTotalChars };
  }
  return {
    section: ["# Heartbeat", result.section].join("\n\n"),
    remainingTotalChars: result.remainingTotalChars,
  };
}

function buildWorkspaceRulesSection(params: {
  workspaceFiles: ContextFile[];
  workspaceDir: string;
  remainingTotalChars: number;
  maxChars: number;
  observability?: {
    loadedFiles: Array<{ name: string; chars: number; hash: string }>;
    skippedFiles: Array<{ name: string; reason: "missing" | "empty" }>;
  };
}): { section: string | null; remainingTotalChars: number } {
  const sections: string[] = [
    "# Workspace Rules",
    `Path: ${sanitizePromptLiteral(params.workspaceDir)}`,
    "Rule: Save work artifacts in the workspace directory.",
  ];

  let remainingTotalChars = params.remainingTotalChars;
  for (const fileName of ["WORK.md", "TOOLS.md"]) {
    const result = buildContextFileSection({
      file: findContextFile(params.workspaceFiles, fileName),
      remainingTotalChars,
      maxChars: params.maxChars,
      observability: params.observability,
    });
    if (result.section) {
      sections.push(result.section);
      remainingTotalChars = result.remainingTotalChars;
    }
  }

  if (sections.length <= 1) {
    return { section: null, remainingTotalChars };
  }

  return { section: sections.join("\n\n"), remainingTotalChars };
}

function buildBootstrapSection(params: {
  bootstrapState: BootstrapState;
  remainingTotalChars: number;
  maxChars: number;
  observability?: {
    loadedFiles: Array<{ name: string; chars: number; hash: string }>;
    skippedFiles: Array<{ name: string; reason: "missing" | "empty" }>;
  };
}): { section: string | null; remainingTotalChars: number } {
  const { bootstrapState } = params;
  if (!bootstrapState.isBootstrapping || !bootstrapState.bootstrapContent?.trim()) {
    return { section: null, remainingTotalChars: params.remainingTotalChars };
  }

  const bootstrapFile: ContextFile = {
    name: "BOOTSTRAP.md",
    path: bootstrapState.bootstrapPath,
    content: bootstrapState.bootstrapContent,
    missing: false,
  };

  const result = buildContextFileSection({
    file: bootstrapFile,
    remainingTotalChars: params.remainingTotalChars,
    maxChars: params.maxChars,
    observability: params.observability,
  });
  if (!result.section) {
    return { section: null, remainingTotalChars: result.remainingTotalChars };
  }

  const header = [
    "# Bootstrap",
    "This is first-run setup. Complete it and then call complete_bootstrap to remove BOOTSTRAP.md.",
  ];
  return {
    section: [...header, result.section].join("\n\n"),
    remainingTotalChars: result.remainingTotalChars,
  };
}

export type PromptMode = "main" | "reset-greeting" | "subagent-minimal";

export interface PromptBuildMetadata {
  mode: PromptMode;
  homeDir: string;
  workspaceDir: string;
  loadedFiles: Array<{ name: string; chars: number; hash: string }>;
  skippedFiles: Array<{ name: string; reason: "missing" | "empty" }>;
  promptHash: string;
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
  const workspaceFiles = await loadWorkspaceFiles(params.workspaceDir);

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

  let remainingTotalChars = DEFAULT_CONTEXT_TOTAL_MAX_CHARS;
  const maxCharsPerFile = DEFAULT_CONTEXT_MAX_CHARS;
  const observability = {
    loadedFiles: [] as Array<{ name: string; chars: number; hash: string }>,
    skippedFiles: [] as Array<{ name: string; reason: "missing" | "empty" }>,
  };

  const bootstrapSection = buildBootstrapSection({
    bootstrapState,
    remainingTotalChars,
    maxChars: maxCharsPerFile,
    observability,
  });
  if (bootstrapSection.section) {
    sections.push(bootstrapSection.section);
  }
  remainingTotalChars = bootstrapSection.remainingTotalChars;

  const agentBehavior = buildAgentBehaviorSection({
    homeFiles,
    remainingTotalChars,
    maxChars: maxCharsPerFile,
    observability,
  });
  if (agentBehavior.section) {
    sections.push(agentBehavior.section);
  }
  remainingTotalChars = agentBehavior.remainingTotalChars;

  const identityPersona = buildIdentityPersonaSection({
    homeFiles,
    remainingTotalChars,
    maxChars: maxCharsPerFile,
    mode,
    observability,
  });
  if (identityPersona.section) {
    sections.push(identityPersona.section);
  }
  remainingTotalChars = identityPersona.remainingTotalChars;

  const heartbeatSection = buildHeartbeatSection({
    homeFiles,
    remainingTotalChars,
    maxChars: maxCharsPerFile,
    mode,
    observability,
  });
  if (heartbeatSection.section) {
    sections.push(heartbeatSection.section);
  }
  remainingTotalChars = heartbeatSection.remainingTotalChars;

  const workspaceRules = buildWorkspaceRulesSection({
    workspaceFiles,
    workspaceDir: params.workspaceDir,
    remainingTotalChars,
    maxChars: maxCharsPerFile,
    observability,
  });
  if (workspaceRules.section) {
    sections.push(workspaceRules.section);
  }
  remainingTotalChars = workspaceRules.remainingTotalChars;

  const runtimeContextParts: string[] = [];
  runtimeContextParts.push(
    buildRuntimePathsPrompt({ homeDir: params.homeDir, workspaceDir: params.workspaceDir }),
  );
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
    params.onMetadata({
      mode,
      homeDir: params.homeDir,
      workspaceDir: params.workspaceDir,
      loadedFiles: observability.loadedFiles,
      skippedFiles: observability.skippedFiles,
      promptHash: createHash("sha256").update(promptText).digest("hex").slice(0, 12),
    });
  }

  return promptText;
}

export async function checkBootstrap(homeDir: string): Promise<BootstrapState> {
  return checkBootstrapState(homeDir);
}
