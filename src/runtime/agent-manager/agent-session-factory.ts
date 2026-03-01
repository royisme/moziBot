import fs from "node:fs/promises";
import path from "node:path";
import type { AgentMessage, AgentTool } from "@mariozechner/pi-agent-core";
import type { Api, Model } from "@mariozechner/pi-ai";
import {
  CURRENT_SESSION_VERSION,
  createAgentSession,
  type AgentSession,
  ModelRegistry as PiCodingModelRegistry,
  SessionManager as PiSessionManager,
  SettingsManager as PiSettingsManager,
} from "@mariozechner/pi-coding-agent";
import { autoCompleteBootstrapIfReady, ensureHome } from "../../agents/home";
import type { SkillLoader } from "../../agents/skills/loader";
import type { ExtensionRegistry } from "../../extensions";
import { logger } from "../../logger";
import { emitSessionTranscriptUpdate } from "../../memory/session-transcript-events";
import {
  CONTEXT_WINDOW_HARD_MIN_TOKENS,
  CONTEXT_WINDOW_WARN_BELOW_TOKENS,
  evaluateContextWindowGuard,
  limitHistoryTurns,
  resolveContextWindowInfo,
} from "../context-management";
import { computeEffectiveSettings, pruneContextMessages } from "../context-pruning";
import type { AuthResolver, ExecRuntime } from "../exec-runtime";
import type { ModelRegistry } from "../model-registry";
import { sanitizePromptInputForModel } from "../payload-sanitizer";
import type { SandboxConfig } from "../sandbox/types";
import type { SessionStore } from "../session-store";
import { resolveSessionFormat } from "../session-store";
import type { SubagentRegistry } from "../subagent-registry";
import type { ModelSpec } from "../types";
import {
  type AgentEntry,
  resolveContextPruningConfig,
  resolveHistoryLimit,
} from "./config-resolver";
import { buildSystemPrompt, type PromptMode } from "./prompt-builder";
import { applySystemPromptOverrideToSession } from "./system-prompt-override";
import { resolveThinkingLevel } from "./thinking-resolver";
import { buildTools } from "./tool-builder";

export async function createAndInitializeAgentSession(params: {
  sessionKey: string;
  resolvedId: string;
  modelRef: string;
  entry?: AgentEntry;
  workspaceDir: string;
  homeDir: string;
  promptMode?: PromptMode;
  config: import("../../config").MoziConfig;
  sessions: SessionStore;
  modelRegistry: ModelRegistry;
  piModelRegistry: PiCodingModelRegistry;
  resolvePiAgentDir: () => string;
  buildPiModel: (spec: ModelSpec) => Model<Api>;
  subagents?: SubagentRegistry;
  skillLoader?: SkillLoader;
  extensionRegistry: ExtensionRegistry;
  skillsIndexSynced: Set<string>;
  toolProvider?: (args: {
    sessionKey: string;
    agentId: string;
    workspaceDir: string;
    homeDir: string;
    sandboxConfig?: SandboxConfig;
  }) => Promise<AgentTool[]> | AgentTool[];
  getExecRuntime: (args: {
    workspaceDir: string;
    sandboxConfig?: SandboxConfig;
    allowlist?: string[];
    allowedSecrets?: string[];
    authResolver?: AuthResolver;
  }) => ExecRuntime;
  sandboxConfig?: SandboxConfig;
  onPromptMetadata?: (metadata: import("./prompt-builder").PromptBuildMetadata) => void;
  onToolsResolved?: (toolNames: string[]) => void;
}): Promise<AgentSession> {
  await ensureHome(params.homeDir);
  await autoCompleteBootstrapIfReady(params.homeDir);
  const sessionState = params.sessions.getOrCreate(params.sessionKey, params.resolvedId);
  const sessionFormat = resolveSessionFormat(sessionState.metadata);
  const sessionFile = sessionState.sessionFile ?? sessionState.latestSessionFile;
  const sessionId = sessionState.sessionId ?? sessionState.latestSessionId;
  const modelSpec = params.modelRegistry.get(params.modelRef);
  if (!modelSpec) {
    throw new Error(`Model not found: ${params.modelRef}`);
  }

  const ctxInfo = resolveContextWindowInfo({
    modelContextWindow: modelSpec.contextWindow,
    configContextTokens: (params.config.agents?.defaults as { contextTokens?: number } | undefined)
      ?.contextTokens,
  });
  const guard = evaluateContextWindowGuard({ info: ctxInfo });
  if (guard.shouldBlock) {
    throw new Error(
      `Model context window (${guard.tokens}) is below minimum (${CONTEXT_WINDOW_HARD_MIN_TOKENS})`,
    );
  }
  if (guard.shouldWarn) {
    logger.warn(
      { contextWindow: guard.tokens, source: guard.source },
      `Model context window (${guard.tokens}) is below recommended (${CONTEXT_WINDOW_WARN_BELOW_TOKENS})`,
    );
  }

  const model = params.buildPiModel(modelSpec);
  const tools = await buildTools(
    {
      sessionKey: params.sessionKey,
      agentId: params.resolvedId,
      entry: params.entry,
      workspaceDir: params.workspaceDir,
      homeDir: params.homeDir,
      sandboxConfig: params.sandboxConfig,
      modelSpec,
    },
    {
      config: params.config,
      subagents: params.subagents,
      skillLoader: params.skillLoader,
      extensionRegistry: params.extensionRegistry,
      toolProvider: params.toolProvider,
      getExecRuntime: (p) => params.getExecRuntime(p),
    },
  );

  const toolNames = Array.from(new Set(tools.map((tool) => tool.name)));
  if (params.onToolsResolved) {
    params.onToolsResolved(toolNames);
  }
  const systemPromptText = await buildSystemPrompt({
    homeDir: params.homeDir,
    workspaceDir: params.workspaceDir,
    basePrompt: params.entry?.systemPrompt,
    skills: params.entry?.skills,
    tools: toolNames,
    sandboxConfig: params.sandboxConfig,
    skillLoader: params.skillLoader,
    skillsIndexSynced: params.skillsIndexSynced,
    mode: params.promptMode,
    onMetadata: params.onPromptMetadata,
  });

  const piSessionManager =
    sessionFormat === "pi" && sessionFile && sessionId
      ? await openPiSessionManager({
          sessionFile,
          sessionId,
          cwd: params.workspaceDir,
        })
      : PiSessionManager.inMemory(params.workspaceDir);
  const piSettingsManager = PiSettingsManager.create(
    params.workspaceDir,
    params.resolvePiAgentDir(),
  );
  const created = await createAgentSession({
    cwd: params.workspaceDir,
    agentDir: params.resolvePiAgentDir(),
    modelRegistry: params.piModelRegistry,
    model,
    tools: [],
    customTools: tools,
    sessionManager: piSessionManager,
    settingsManager: piSettingsManager,
  });
  const agent = created.session;
  if (sessionFormat === "pi") {
    installSessionTranscriptEmitter(agent.sessionManager);
  }
  applySystemPromptOverrideToSession(agent, systemPromptText);

  let persistedContext =
    sessionFormat === "legacy" && Array.isArray(sessionState.context)
      ? (sessionState.context as AgentMessage[])
      : agent.messages;
  if (persistedContext.length > 0) {
    const historyLimit = resolveHistoryLimit(params.config, params.sessionKey);
    if (historyLimit && historyLimit > 0) {
      persistedContext = limitHistoryTurns(persistedContext, historyLimit);
    }
    const pruningConfig = resolveContextPruningConfig(params.config, params.entry);
    const pruningSettings = computeEffectiveSettings(pruningConfig);
    const pruningResult = pruneContextMessages({
      messages: persistedContext,
      settings: pruningSettings,
      contextWindowTokens: modelSpec.contextWindow ?? 128000,
    });
    if (pruningResult.stats.charsSaved > 0) {
      logger.info(
        {
          sessionKey: params.sessionKey,
          softTrimmed: pruningResult.stats.softTrimCount,
          hardCleared: pruningResult.stats.hardClearCount,
          charsSaved: pruningResult.stats.charsSaved,
          ratio: pruningResult.stats.ratio.toFixed(2),
        },
        "Context pruning applied",
      );
    }
    const sanitizedMessages = sanitizePromptInputForModel(
      pruningResult.messages,
      params.modelRef,
      modelSpec.api,
      modelSpec.provider,
    );
    agent.agent.replaceMessages(sanitizedMessages);
  }

  const thinkingLevel = resolveThinkingLevel({
    config: params.config,
    sessions: params.sessions,
    entry: params.entry,
    sessionKey: params.sessionKey,
  });
  if (thinkingLevel) {
    agent.setThinkingLevel(thinkingLevel);
  }

  return agent;
}

async function openPiSessionManager(params: {
  sessionFile: string;
  sessionId: string;
  cwd: string;
}): Promise<PiSessionManager> {
  await ensurePiSessionHeader(params);
  return PiSessionManager.open(params.sessionFile);
}

async function ensurePiSessionHeader(params: {
  sessionFile: string;
  sessionId: string;
  cwd: string;
}): Promise<void> {
  try {
    const stat = await fs.stat(params.sessionFile);
    if (stat.size > 0) {
      return;
    }
  } catch {
    // File missing; we'll create it below.
  }

  await fs.mkdir(path.dirname(params.sessionFile), { recursive: true });
  const header = {
    type: "session",
    version: CURRENT_SESSION_VERSION,
    id: params.sessionId,
    timestamp: new Date().toISOString(),
    cwd: params.cwd,
  };
  await fs.writeFile(params.sessionFile, `${JSON.stringify(header)}\n`, {
    encoding: "utf-8",
    mode: 0o600,
  });
}

const SESSION_EMITTER_MARK = "__moziTranscriptEmitterInstalled";

function installSessionTranscriptEmitter(sessionManager: PiSessionManager): void {
  const tagged = sessionManager as unknown as Record<string, boolean>;
  if (tagged[SESSION_EMITTER_MARK]) {
    return;
  }
  tagged[SESSION_EMITTER_MARK] = true;

  const originalAppend = sessionManager.appendMessage.bind(sessionManager);
  sessionManager.appendMessage = ((message) => {
    const result = originalAppend(message as never);
    const sessionFile = (
      sessionManager as { getSessionFile?: () => string | undefined }
    ).getSessionFile?.();
    if (sessionFile) {
      emitSessionTranscriptUpdate(sessionFile);
    }
    return result;
  }) as PiSessionManager["appendMessage"];
}
