import type { Api, Model } from "@mariozechner/pi-ai";
import { type AgentTool, type ThinkingLevel } from "@mariozechner/pi-agent-core";
import {
  AuthStorage as PiAuthStorage,
  type AgentSession,
  ModelRegistry as PiCodingModelRegistry,
} from "@mariozechner/pi-coding-agent";
import os from "node:os";
import path from "node:path";
import type { MoziConfig } from "../config";
import type { InboundMessage } from "./adapters/channels/types";
import type { SandboxConfig } from "./sandbox/types";
import type { SubagentRegistry } from "./subagent-registry";
import type { ModelSpec } from "./types";
import {
  ensureHome,
  loadHomeFiles,
  buildContextFromFiles,
  type BootstrapState,
} from "../agents/home";
import { SkillLoader } from "../agents/skills/loader";
import { type ExtensionRegistry } from "../extensions";
import { logger } from "../logger";
import { clearMemoryManagerCache } from "../memory";
import { createAndInitializeAgentSession } from "./agent-manager/agent-session-factory";
import { resolveOrCreateAgentSession } from "./agent-manager/agent-session-orchestrator";
// Extracted modules
import {
  type AgentEntry,
  resolveWorkspaceDir,
  resolveSandboxConfig,
  resolveExecAllowlist,
  resolvePromptTimeoutMs as resolvePromptTimeoutMsFromConfig,
  resolveSubagentPromptMode,
} from "./agent-manager/config-resolver";
import {
  compactSession as compactSessionMetric,
  getContextBreakdown as getContextBreakdownMetric,
  getContextUsage as getContextUsageMetric,
  updateSessionContext as updateSessionContextMetric,
} from "./agent-manager/context-metrics";
import {
  createExtensionRegistry,
  createSkillLoader,
  initExtensions,
  rebuildLifecycle,
  shutdownExtensions as shutdownExtensionsLifecycle,
} from "./agent-manager/lifecycle";
import {
  ensureSessionModelForInput as ensureSessionModelForInputService,
  getAgentFallbacks as getAgentFallbacksService,
  resolveAgentModelRef as resolveAgentModelRefService,
  resolveLifecycleControlModel as resolveLifecycleControlModelService,
  setSessionModel as setSessionModelService,
} from "./agent-manager/model-session-service";
import {
  buildChannelContext,
  buildSystemPrompt,
  checkBootstrap,
  type PromptBuildMetadata,
  type PromptMode,
} from "./agent-manager/prompt-builder";
import {
  clearRuntimeModelOverride as clearRuntimeModelOverrideState,
  disposeAllRuntimeSessions,
  disposeRuntimeSession as disposeRuntimeSessionState,
  resetSession as resetSessionState,
} from "./agent-manager/runtime-state";
import { resolveThinkingLevel } from "./agent-manager/thinking-resolver";
import { ModelRegistry } from "./model-registry";
import { ProviderRegistry } from "./provider-registry";
import {
  buildSandboxExecutorCacheKey,
  createSandboxExecutor,
  type SandboxProbeResult,
  type SandboxExecutor,
} from "./sandbox/executor";
import { SessionStore } from "./session-store";

export type { AgentEntry };

export type ResolvedAgent = {
  agent: AgentSession;
  agentId: string;
  systemPrompt: string;
  modelRef: string;
};

export type AgentSandboxProbeReport = {
  agentId: string;
  result: SandboxProbeResult;
};

function normalizePiInputCapabilities(
  input: Array<"text" | "image" | "audio" | "video" | "file"> | undefined,
): Array<"text" | "image"> {
  const supported = input ?? ["text"];
  const normalized = supported.filter(
    (item): item is "text" | "image" => item === "text" || item === "image",
  );
  return normalized.length > 0 ? normalized : ["text"];
}

export class AgentManager {
  private agents = new Map<string, AgentSession>();
  private agentModelRefs = new Map<string, string>();
  private runtimeModelOverrides = new Map<string, string>();
  private homeContext = new Map<string, string>();
  private channelContextSessions = new Set<string>();
  private promptMetadataBySession = new Map<string, PromptBuildMetadata>();
  private sandboxExecutors = new Map<string, SandboxExecutor>();
  private modelRegistry: ModelRegistry;
  private providerRegistry: ProviderRegistry;
  private sessions: SessionStore;
  private config: MoziConfig;
  private subagents?: SubagentRegistry;
  private skillLoader?: SkillLoader;
  private skillsIndexSynced = new Set<string>();
  private extensionRegistry: ExtensionRegistry;
  private piModelRegistry: PiCodingModelRegistry;
  private toolProvider?: (params: {
    sessionKey: string;
    agentId: string;
    workspaceDir: string;
    homeDir: string;
    sandboxConfig?: SandboxConfig;
  }) => Promise<AgentTool[]> | AgentTool[];

  constructor(params: {
    config: MoziConfig;
    modelRegistry: ModelRegistry;
    providerRegistry: ProviderRegistry;
    sessions: SessionStore;
  }) {
    this.config = params.config;
    this.modelRegistry = params.modelRegistry;
    this.providerRegistry = params.providerRegistry;
    this.sessions = params.sessions;
    this.extensionRegistry = createExtensionRegistry(this.config);
    this.piModelRegistry = this.createPiModelRegistry();
    this.skillLoader = createSkillLoader(this.config, this.extensionRegistry);
  }

  private initSkillLoader() {
    this.skillLoader = createSkillLoader(this.config, this.extensionRegistry);
  }

  private resolvePiAgentDir(): string {
    const baseDir = this.config.paths?.baseDir || path.join(os.homedir(), ".mozi");
    return path.join(baseDir, "pi-agent");
  }

  private resolveDefaultBaseUrl(api?: string): string | undefined {
    switch (api) {
      case "openai-responses":
      case "openai-chat":
        return "https://api.openai.com/v1";
      case "anthropic":
        return "https://api.anthropic.com/v1";
      case "google-generative-ai":
        return "https://generativelanguage.googleapis.com/v1beta";
      default:
        return undefined;
    }
  }

  private createPiModelRegistry(): PiCodingModelRegistry {
    const agentDir = this.resolvePiAgentDir();
    const authStorage = new PiAuthStorage(path.join(agentDir, "auth.json"));
    const registry = new PiCodingModelRegistry(authStorage, undefined);
    const providers = this.config.models?.providers || {};
    for (const [providerName, providerConfig] of Object.entries(providers)) {
      const models = providerConfig.models || [];
      if (models.length === 0) {
        continue;
      }
      const baseUrl = providerConfig.baseUrl || this.resolveDefaultBaseUrl(providerConfig.api);
      if (!baseUrl) {
        continue;
      }
      registry.registerProvider(providerName, {
        api: providerConfig.api,
        baseUrl,
        apiKey: providerConfig.apiKey,
        headers: providerConfig.headers,
        models: models.map((model) => ({
          id: model.id,
          name: model.name ?? model.id,
          api: model.api,
          reasoning: model.reasoning ?? false,
          input: normalizePiInputCapabilities(model.input),
          contextWindow: model.contextWindow ?? 128000,
          maxTokens: model.maxTokens ?? 8192,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          headers: model.headers,
        })),
      });
    }
    return registry;
  }

  async reloadConfig(params: {
    config: MoziConfig;
    modelRegistry: ModelRegistry;
    providerRegistry: ProviderRegistry;
  }) {
    const previousRegistry = this.extensionRegistry;
    this.config = params.config;
    this.modelRegistry = params.modelRegistry;
    this.providerRegistry = params.providerRegistry;
    const lifecycle = await rebuildLifecycle({
      previousRegistry,
      config: this.config,
    });
    this.extensionRegistry = lifecycle.extensionRegistry;
    this.skillLoader = lifecycle.skillLoader;
    this.piModelRegistry = this.createPiModelRegistry();
    this.skillsIndexSynced.clear();
    clearMemoryManagerCache();
    this.sandboxExecutors.clear();
    disposeAllRuntimeSessions({
      agents: this.agents,
      agentModelRefs: this.agentModelRefs,
      runtimeModelOverrides: this.runtimeModelOverrides,
      channelContextSessions: this.channelContextSessions,
    });
  }

  setSubagentRegistry(registry: SubagentRegistry) {
    this.subagents = registry;
  }

  getExtensionRegistry(): ExtensionRegistry {
    return this.extensionRegistry;
  }

  async initExtensionsAsync(): Promise<void> {
    await initExtensions(this.config, this.extensionRegistry);
    this.initSkillLoader();
  }

  async shutdownExtensions(): Promise<void> {
    await shutdownExtensionsLifecycle(this.extensionRegistry);
  }

  setToolProvider(
    provider?: (params: {
      sessionKey: string;
      agentId: string;
      workspaceDir: string;
      homeDir: string;
      sandboxConfig?: SandboxConfig;
    }) => Promise<AgentTool[]> | AgentTool[],
  ) {
    this.toolProvider = provider;
  }

  private listAgentEntries(): Array<{ id: string; entry: AgentEntry }> {
    const agents = this.config.agents || {};
    return Object.entries(agents)
      .filter(([key]) => key !== "defaults")
      .map(([id, entry]) => ({ id, entry: entry as AgentEntry }));
  }

  resolveDefaultAgentId(): string {
    const entries = this.listAgentEntries();
    const mainAgent = entries.find((e) => e.entry.main === true);
    if (mainAgent?.id) {
      return mainAgent.id;
    }
    return entries[0]?.id || "mozi";
  }

  getAgentEntry(agentId: string) {
    const agents = this.config.agents || {};
    const entry = (agents as Record<string, unknown>)[agentId] as AgentEntry | undefined;
    return entry;
  }

  resolveSubagentPromptMode(parentAgentId: string): "minimal" | "full" {
    const parentEntry = this.getAgentEntry(parentAgentId);
    return resolveSubagentPromptMode(this.config, parentEntry);
  }

  async probeSandboxes(): Promise<AgentSandboxProbeReport[]> {
    const reports: AgentSandboxProbeReport[] = [];
    const entries = this.listAgentEntries();
    for (const { id, entry } of entries) {
      const sandboxConfig = resolveSandboxConfig(this.config, entry);
      const mode = sandboxConfig?.mode ?? "off";
      const vibeboxEnabled =
        sandboxConfig?.apple?.backend === "vibebox" ||
        sandboxConfig?.apple?.vibebox?.enabled === true;
      if (mode !== "docker" && mode !== "apple-vm" && !vibeboxEnabled) {
        continue;
      }
      const executor = this.getSandboxExecutor({
        sandboxConfig,
        allowlist: resolveExecAllowlist(this.config, entry),
      });
      const result = await executor.probe();
      reports.push({ agentId: id, result });
    }
    return reports;
  }

  getWorkspaceDir(agentId: string): string | undefined {
    const entry = this.getAgentEntry(agentId);
    if (!entry) {
      return undefined;
    }
    return resolveWorkspaceDir(this.config, agentId, entry);
  }

  private async getHomeContext(homeDir: string): Promise<string> {
    const cached = this.homeContext.get(homeDir);
    if (cached !== undefined) {
      return cached;
    }
    await ensureHome(homeDir);
    const files = await loadHomeFiles(homeDir);
    const context = buildContextFromFiles(files);
    this.homeContext.set(homeDir, context);
    return context;
  }

  async ensureChannelContext(params: {
    sessionKey: string;
    agentId: string;
    message: InboundMessage;
  }): Promise<void> {
    if (this.channelContextSessions.has(params.sessionKey)) {
      return;
    }
    const { agent } = await this.getAgent(params.sessionKey, params.agentId);
    const context = buildChannelContext(params.message);
    if (!context) {
      return;
    }
    agent.agent.setSystemPrompt(`${agent.systemPrompt}\n\n${context}`);
    this.channelContextSessions.add(params.sessionKey);
  }

  private getSandboxExecutor(params: {
    sandboxConfig?: SandboxConfig;
    allowlist?: string[];
  }): SandboxExecutor {
    const key = buildSandboxExecutorCacheKey({
      config: params.sandboxConfig,
      allowlist: params.allowlist,
    });
    const existing = this.sandboxExecutors.get(key);
    if (existing) {
      return existing;
    }
    const executor = createSandboxExecutor({
      config: params.sandboxConfig,
      allowlist: params.allowlist,
    });
    this.sandboxExecutors.set(key, executor);
    return executor;
  }

  private resolveAgentModelRef(agentId: string, entry?: AgentEntry): string | undefined {
    return resolveAgentModelRefService({
      config: this.config,
      agentId,
      entry,
    });
  }

  resolveConfiguredThinkingLevel(agentId: string): ThinkingLevel | undefined {
    const entry = this.getAgentEntry(agentId);
    return resolveThinkingLevel({ config: this.config, sessions: this.sessions, entry });
  }

  resolvePromptTimeoutMs(agentId: string): number {
    const entry = this.getAgentEntry(agentId);
    return resolvePromptTimeoutMsFromConfig(this.config, entry);
  }

  getAgentFallbacks(agentId: string): string[] {
    return getAgentFallbacksService({
      config: this.config,
      agentId,
    });
  }

  resolveLifecycleControlModel(params: { sessionKey: string; agentId?: string }): {
    modelRef: string;
    source: "session" | "agent" | "defaults" | "fallback";
  } {
    return resolveLifecycleControlModelService({
      ...params,
      config: this.config,
      sessions: this.sessions,
      modelRegistry: this.modelRegistry,
      resolveDefaultAgentId: () => this.resolveDefaultAgentId(),
      getAgentEntry: (agentId) => this.getAgentEntry(agentId),
    });
  }

  async ensureSessionModelForInput(params: {
    sessionKey: string;
    agentId: string;
    input: "text" | "image" | "audio" | "video" | "file";
  }): Promise<
    | { ok: true; modelRef: string; switched: boolean }
    | { ok: false; modelRef: string; candidates: string[] }
  > {
    return await ensureSessionModelForInputService({
      ...params,
      config: this.config,
      modelRegistry: this.modelRegistry,
      getAgent: async (sessionKey, agentId) => await this.getAgent(sessionKey, agentId),
      setSessionModel: async (sessionKey, modelRef, options) =>
        await this.setSessionModel(sessionKey, modelRef, options),
    });
  }

  private buildPiModel(spec: ModelSpec): Model<Api> {
    return {
      id: spec.id,
      name: spec.id,
      api: spec.api,
      provider: spec.provider,
      baseUrl: spec.baseUrl,
      reasoning: spec.reasoning ?? false,
      input: normalizePiInputCapabilities(spec.input),
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: spec.contextWindow ?? 128000,
      maxTokens: spec.maxTokens ?? 8192,
      headers: spec.headers,
    } as Model<Api>;
  }

  async getAgent(
    sessionKey: string,
    agentId?: string,
    options?: { promptMode?: PromptMode },
  ): Promise<ResolvedAgent> {
    const { agent, resolvedId, entry, modelRef } = await resolveOrCreateAgentSession({
      sessionKey,
      agentId,
      config: this.config,
      sessions: this.sessions,
      agents: this.agents,
      agentModelRefs: this.agentModelRefs,
      runtimeModelOverrides: this.runtimeModelOverrides,
      resolveDefaultAgentId: () => this.resolveDefaultAgentId(),
      getAgentEntry: (agentId) => this.getAgentEntry(agentId),
      resolveAgentModelRef: (agentId, entry) => this.resolveAgentModelRef(agentId, entry),
      setSessionModel: async (sessionKey, modelRef, options) =>
        await this.setSessionModel(sessionKey, modelRef, options),
      createAndInitializeAgentSession: async (params) =>
        await createAndInitializeAgentSession({
          ...params,
          config: this.config,
          sessions: this.sessions,
          modelRegistry: this.modelRegistry,
          piModelRegistry: this.piModelRegistry,
          resolvePiAgentDir: () => this.resolvePiAgentDir(),
          buildPiModel: (spec) => this.buildPiModel(spec),
          subagents: this.subagents,
          skillLoader: this.skillLoader,
          extensionRegistry: this.extensionRegistry,
          skillsIndexSynced: this.skillsIndexSynced,
          toolProvider: this.toolProvider,
          getSandboxExecutor: (p) => this.getSandboxExecutor(p),
        }),
      promptMode: options?.promptMode,
      onPromptMetadata: (metadata) => {
        this.promptMetadataBySession.set(sessionKey, metadata);
        logger.debug(
          {
            sessionKey,
            agentId: agentId ?? "auto",
            promptMode: metadata.mode,
            promptHash: metadata.promptHash,
            loadedFiles: metadata.loadedFiles,
            skippedFiles: metadata.skippedFiles,
          },
          "Prompt files resolved",
        );
      },
    });

    const thinkingLevel = resolveThinkingLevel({
      config: this.config,
      sessions: this.sessions,
      entry,
      sessionKey,
    });
    if (thinkingLevel) {
      agent.setThinkingLevel(thinkingLevel);
    }

    return {
      agent,
      agentId: resolvedId,
      systemPrompt: agent.systemPrompt,
      modelRef,
    };
  }

  /**
   * Check if home is in bootstrap mode
   */
  async checkBootstrap(homeDir: string): Promise<BootstrapState> {
    return checkBootstrap(homeDir);
  }

  /**
   * Build system prompt with home context, workspace context, and bootstrap awareness
   */
  async buildSystemPrompt(params: {
    homeDir: string;
    workspaceDir: string;
    basePrompt?: string;
    skills?: string[];
    tools?: string[];
    sandboxConfig?: SandboxConfig;
  }): Promise<string> {
    return buildSystemPrompt({
      ...params,
      skillLoader: this.skillLoader,
      skillsIndexSynced: this.skillsIndexSynced,
    });
  }

  async setSessionModel(
    sessionKey: string,
    modelRef: string,
    options?: { persist?: boolean },
  ): Promise<void> {
    await setSessionModelService({
      sessionKey,
      modelRef,
      options,
      sessions: this.sessions,
      runtimeModelOverrides: this.runtimeModelOverrides,
      agents: this.agents,
      agentModelRefs: this.agentModelRefs,
      modelRegistry: this.modelRegistry,
      config: this.config,
      buildPiModel: (spec) => this.buildPiModel(spec),
    });
  }

  clearRuntimeModelOverride(sessionKey: string): void {
    clearRuntimeModelOverrideState({
      sessionKey,
      runtimeModelOverrides: this.runtimeModelOverrides,
    });
  }

  resetSession(sessionKey: string, agentId?: string): void {
    resetSessionState({
      sessionKey,
      agentId,
      sessions: this.sessions,
      resolveDefaultAgentId: () => this.resolveDefaultAgentId(),
      disposeRuntimeSession: (targetSessionKey) => this.disposeRuntimeSession(targetSessionKey),
    });
  }

  disposeRuntimeSession(sessionKey: string): void {
    disposeRuntimeSessionState({
      sessionKey,
      agents: this.agents,
      agentModelRefs: this.agentModelRefs,
      runtimeModelOverrides: this.runtimeModelOverrides,
      channelContextSessions: this.channelContextSessions,
    });
    this.promptMetadataBySession.delete(sessionKey);
  }

  updateSessionContext(sessionKey: string, messages: unknown): void {
    updateSessionContextMetric({
      sessionKey,
      messages,
      sessions: this.sessions,
      modelRegistry: this.modelRegistry,
      agentModelRefs: this.agentModelRefs,
    });
  }

  getSessionMetadata(sessionKey: string): Record<string, unknown> | undefined {
    return this.sessions.get(sessionKey)?.metadata;
  }

  getPromptMetadata(sessionKey: string): PromptBuildMetadata | undefined {
    return this.promptMetadataBySession.get(sessionKey);
  }

  updateSessionMetadata(sessionKey: string, metadata: Record<string, unknown>): void {
    const current = this.sessions.get(sessionKey)?.metadata || {};
    this.sessions.update(sessionKey, { metadata: { ...current, ...metadata } });
  }

  async compactSession(
    sessionKey: string,
    _agentId?: string,
  ): Promise<{
    success: boolean;
    tokensReclaimed: number;
    reason?: string;
  }> {
    return await compactSessionMetric({
      sessionKey,
      agents: this.agents,
      sessions: this.sessions,
    });
  }

  getContextUsage(sessionKey: string): {
    usedTokens: number;
    totalTokens: number;
    percentage: number;
    messageCount: number;
  } | null {
    return getContextUsageMetric({
      sessionKey,
      agents: this.agents,
      agentModelRefs: this.agentModelRefs,
      modelRegistry: this.modelRegistry,
    });
  }

  getContextBreakdown(sessionKey: string): {
    systemPromptTokens: number;
    userMessageTokens: number;
    assistantMessageTokens: number;
    toolResultTokens: number;
    totalTokens: number;
  } | null {
    return getContextBreakdownMetric({
      sessionKey,
      agents: this.agents,
    });
  }
}
