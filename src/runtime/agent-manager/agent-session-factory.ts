import type { AgentMessage, AgentTool } from "@mariozechner/pi-agent-core";
import type { Api, Model } from "@mariozechner/pi-ai";
import {
  createAgentSession,
  type AgentSession,
  ModelRegistry as PiCodingModelRegistry,
  SessionManager as PiSessionManager,
  SettingsManager as PiSettingsManager,
} from "@mariozechner/pi-coding-agent";
import type { SkillLoader } from "../../agents/skills/loader";
import type { ExtensionRegistry } from "../../extensions";
import type { ModelRegistry } from "../model-registry";
import type { SandboxExecutor } from "../sandbox/executor";
import type { SandboxConfig } from "../sandbox/types";
import type { SessionStore } from "../session-store";
import type { SubagentRegistry } from "../subagent-registry";
import type { ModelSpec } from "../types";
import { logger } from "../../logger";
import {
  CONTEXT_WINDOW_HARD_MIN_TOKENS,
  CONTEXT_WINDOW_WARN_BELOW_TOKENS,
  evaluateContextWindowGuard,
  limitHistoryTurns,
  resolveContextWindowInfo,
} from "../context-management";
import { computeEffectiveSettings, pruneContextMessages } from "../context-pruning";
import { sanitizePromptInputForModel } from "../payload-sanitizer";
import {
  type AgentEntry,
  resolveContextPruningConfig,
  resolveHistoryLimit,
} from "./config-resolver";
import { buildSystemPrompt, type PromptMode } from "./prompt-builder";
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
  getSandboxExecutor: (args: {
    sandboxConfig?: SandboxConfig;
    allowlist?: string[];
  }) => SandboxExecutor;
  sandboxConfig?: SandboxConfig;
  onPromptMetadata?: (metadata: import("./prompt-builder").PromptBuildMetadata) => void;
}): Promise<AgentSession> {
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
      getSandboxExecutor: (p) => params.getSandboxExecutor(p),
    },
  );

  const toolNames = Array.from(new Set(tools.map((tool) => tool.name)));
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

  const piSessionManager = PiSessionManager.inMemory(params.workspaceDir);
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
  agent.agent.setSystemPrompt(systemPromptText);

  const session = params.sessions.get(params.sessionKey);
  let persistedContext = Array.isArray(session?.context) ? (session.context as AgentMessage[]) : [];
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
