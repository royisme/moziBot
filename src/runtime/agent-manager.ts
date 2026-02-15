import type { Api, Model } from "@mariozechner/pi-ai";
import { type AgentMessage, type AgentTool, type ThinkingLevel } from "@mariozechner/pi-agent-core";
import {
  AuthStorage as PiAuthStorage,
  createAgentSession,
  type AgentSession,
  ModelRegistry as PiCodingModelRegistry,
  SessionManager as PiSessionManager,
  SettingsManager as PiSettingsManager,
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
import { resolveAgentModelRouting } from "../config/model-routing";
import { type ExtensionRegistry, initExtensionsAsync, loadExtensions } from "../extensions";
import { logger } from "../logger";
import {
  clearMemoryManagerCache,
} from "../memory";
import {
  resolveContextWindowInfo,
  evaluateContextWindowGuard,
  CONTEXT_WINDOW_HARD_MIN_TOKENS,
  CONTEXT_WINDOW_WARN_BELOW_TOKENS,
  limitHistoryTurns,
  estimateTokens,
  estimateMessagesTokens,
} from "./context-management";
import {
  pruneContextMessages,
  computeEffectiveSettings,
} from "./context-pruning";
import { ModelRegistry } from "./model-registry";
import { sanitizePromptInputForModel } from "./payload-sanitizer";
import { ProviderRegistry } from "./provider-registry";
import {
  buildSandboxExecutorCacheKey,
  createSandboxExecutor,
  type SandboxProbeResult,
  type SandboxExecutor,
} from "./sandbox/executor";
import { SessionStore } from "./session-store";
import { filterTools } from "./tool-selection";

// Extracted modules
import {
  type AgentEntry,
  resolveWorkspaceDir,
  resolveHomeDir,
  resolveSandboxConfig,
  resolveExecAllowlist,
  resolveExecAllowedSecrets,
  resolveToolAllowList,
  resolveContextPruningConfig,
  resolveHistoryLimit,
  resolvePromptTimeoutMs as resolvePromptTimeoutMsFromConfig,
} from "./agent-manager/config-resolver";
import {
  isThinkingLevel,
  resolveThinkingLevel,
} from "./agent-manager/thinking-resolver";
import {
  buildChannelContext,
  buildSandboxPrompt,
  buildToolsSection,
  buildSkillsSection,
  buildSystemPrompt,
  checkBootstrap,
} from "./agent-manager/prompt-builder";
import {
  buildTools,
  shouldSanitizeTools,
} from "./agent-manager/tool-builder";

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
    this.extensionRegistry = loadExtensions(this.config.extensions);
    this.piModelRegistry = this.createPiModelRegistry();
    this.initSkillLoader();
  }

  private initSkillLoader() {
    const dirs: string[] = [];
    const bundledDir = path.join(process.env.PI_PACKAGE_DIR || process.cwd(), "skills", "bundled");
    dirs.push(bundledDir);
    const baseDir = this.config.paths?.baseDir || path.join(os.homedir(), ".mozi");
    dirs.push(path.join(baseDir, "skills"));
    const extraDirs = this.config.skills?.dirs || [];
    dirs.push(...extraDirs);
    if (this.config.paths?.skills) {
      dirs.push(this.config.paths.skills);
    }
    // Merge skill directories exported by enabled extensions
    const extSkillDirs = this.extensionRegistry.collectSkillDirs();
    dirs.push(...extSkillDirs);
    this.skillLoader = new SkillLoader(dirs, {
      bundledDirs: [bundledDir],
      allowBundled: this.config.skills?.allowBundled,
    });
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
    await this.extensionRegistry.shutdown();
    this.config = params.config;
    this.modelRegistry = params.modelRegistry;
    this.providerRegistry = params.providerRegistry;
    this.extensionRegistry = loadExtensions(this.config.extensions);
    this.piModelRegistry = this.createPiModelRegistry();
    await this.initExtensionsAsync();
    this.initSkillLoader();
    this.skillsIndexSynced.clear();
    clearMemoryManagerCache();
    this.sandboxExecutors.clear();
    for (const session of this.agents.values()) {
      session.dispose();
    }
    this.agents.clear();
    this.channelContextSessions.clear();
  }

  setSubagentRegistry(registry: SubagentRegistry) {
    this.subagents = registry;
  }

  getExtensionRegistry(): ExtensionRegistry {
    return this.extensionRegistry;
  }

  async initExtensionsAsync(): Promise<void> {
    await initExtensionsAsync(this.config.extensions, this.extensionRegistry);
  }

  async shutdownExtensions(): Promise<void> {
    await this.extensionRegistry.shutdown();
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
    const routing = resolveAgentModelRouting(this.config, agentId);
    if (routing.defaultModel.primary) {
      return routing.defaultModel.primary;
    }
    if (entry?.model && typeof entry.model === "string") {
      return entry.model;
    }
    return undefined;
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
    const routing = resolveAgentModelRouting(this.config, agentId);
    return routing.defaultModel.fallbacks;
  }

  resolveLifecycleControlModel(params: { sessionKey: string; agentId?: string }): {
    modelRef: string;
    source: "session" | "agent" | "defaults" | "fallback";
  } {
    const { sessionKey } = params;
    const resolvedAgentId = params.agentId || this.resolveDefaultAgentId();
    const entry = this.getAgentEntry(resolvedAgentId);
    const defaults = (this.config.agents?.defaults as AgentEntry | undefined) || undefined;
    const sessionControl =
      (this.sessions.get(sessionKey)?.metadata?.lifecycle as { controlModel?: string } | undefined)
        ?.controlModel || undefined;

    if (sessionControl && this.modelRegistry.get(sessionControl)) {
      return { modelRef: sessionControl, source: "session" };
    }

    const agentControl = entry?.lifecycle?.control?.model;
    if (agentControl && this.modelRegistry.get(agentControl)) {
      return { modelRef: agentControl, source: "agent" };
    }

    const defaultsControl = defaults?.lifecycle?.control?.model;
    if (defaultsControl && this.modelRegistry.get(defaultsControl)) {
      return { modelRef: defaultsControl, source: "defaults" };
    }

    const fallbacks = [
      ...(entry?.lifecycle?.control?.fallback || []),
      ...(defaults?.lifecycle?.control?.fallback || []),
    ];
    const deterministic = Array.from(new Set(fallbacks)).toSorted();
    for (const ref of deterministic) {
      if (this.modelRegistry.get(ref)) {
        return { modelRef: ref, source: "fallback" };
      }
    }

    const defaultReply = this.resolveAgentModelRef(resolvedAgentId, entry);
    if (defaultReply && this.modelRegistry.get(defaultReply)) {
      return { modelRef: defaultReply, source: "fallback" };
    }

    const first = this.modelRegistry
      .list()
      .map((spec) => `${spec.provider}/${spec.id}`)
      .toSorted()[0];
    if (!first) {
      throw new Error("No model available for lifecycle control plane");
    }
    return { modelRef: first, source: "fallback" };
  }

  private modelSupportsInput(
    modelRef: string,
    input: "text" | "image" | "audio" | "video" | "file",
  ): boolean {
    const spec = this.modelRegistry.get(modelRef);
    if (!spec) {
      return false;
    }
    const supported = spec.input ?? ["text"];
    return supported.includes(input);
  }

  private getAgentModalityModelRef(
    agentId: string,
    modality: "image" | "audio" | "video" | "file",
  ): string | undefined {
    const routing = resolveAgentModelRouting(this.config, agentId);
    if (modality !== "image") {
      return undefined;
    }
    return routing.imageModel.primary;
  }

  private getAgentModalityFallbacks(
    agentId: string,
    modality: "image" | "audio" | "video" | "file",
  ): string[] {
    const routing = resolveAgentModelRouting(this.config, agentId);
    if (modality !== "image") {
      return [];
    }
    return routing.imageModel.fallbacks;
  }

  private resolveModalityRoutingCandidates(
    agentId: string,
    modality: "image" | "audio" | "video" | "file",
  ): string[] {
    const refs = [
      this.getAgentModalityModelRef(agentId, modality),
      ...this.getAgentModalityFallbacks(agentId, modality),
      ...this.getAgentFallbacks(agentId),
    ].filter((ref): ref is string => Boolean(ref));
    return Array.from(new Set(refs));
  }

  private listCapableModels(input: "text" | "image" | "audio" | "video" | "file"): string[] {
    return this.modelRegistry
      .list()
      .filter((spec) => (spec.input ?? ["text"]).includes(input))
      .map((spec) => `${spec.provider}/${spec.id}`)
      .toSorted();
  }

  async ensureSessionModelForInput(params: {
    sessionKey: string;
    agentId: string;
    input: "text" | "image" | "audio" | "video" | "file";
  }): Promise<
    | { ok: true; modelRef: string; switched: boolean }
    | { ok: false; modelRef: string; candidates: string[] }
  > {
    const { sessionKey, agentId, input } = params;
    const { modelRef } = await this.getAgent(sessionKey, agentId);
    if (this.modelSupportsInput(modelRef, input)) {
      return { ok: true, modelRef, switched: false };
    }

    if (input === "text") {
      return { ok: false, modelRef, candidates: this.listCapableModels("text") };
    }

    const candidates = this.resolveModalityRoutingCandidates(agentId, input);
    for (const candidate of candidates) {
      const resolved = this.modelRegistry.resolve(candidate);
      if (!resolved) {
        continue;
      }
      if (!this.modelSupportsInput(resolved.ref, input)) {
        continue;
      }
      await this.setSessionModel(sessionKey, resolved.ref, { persist: false });
      return { ok: true, modelRef: resolved.ref, switched: resolved.ref !== modelRef };
    }

    return { ok: false, modelRef, candidates: this.listCapableModels(input) };
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

  async getAgent(sessionKey: string, agentId?: string): Promise<ResolvedAgent> {
    const resolvedId = agentId || this.resolveDefaultAgentId();
    const entry = this.getAgentEntry(resolvedId);
    const workspaceDir = resolveWorkspaceDir(this.config, resolvedId, entry);
    const homeDir = resolveHomeDir(this.config, resolvedId, entry);
    const session = this.sessions.getOrCreate(sessionKey, resolvedId);

    const runtimeOverride = this.runtimeModelOverrides.get(sessionKey);
    const lockedModel = session.currentModel;
    const modelRef = runtimeOverride || lockedModel || this.resolveAgentModelRef(resolvedId, entry);
    if (!modelRef) {
      throw new Error(`No model configured for agent ${resolvedId}`);
    }

    let agent = this.agents.get(sessionKey);
    if (agent) {
      const activeModelRef = this.agentModelRefs.get(sessionKey);
      if (activeModelRef !== modelRef) {
        await this.setSessionModel(sessionKey, modelRef, { persist: false });
        agent = this.agents.get(sessionKey);
      }
    }
    if (!agent) {
      const modelSpec = this.modelRegistry.get(modelRef);
      if (!modelSpec) {
        throw new Error(`Model not found: ${modelRef}`);
      }

      const ctxInfo = resolveContextWindowInfo({
        modelContextWindow: modelSpec.contextWindow,
        configContextTokens: (
          this.config.agents?.defaults as { contextTokens?: number } | undefined
        )?.contextTokens,
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

      const sandboxConfig = resolveSandboxConfig(this.config, entry);
      const model = this.buildPiModel(modelSpec);
      const tools = await buildTools(
        {
          sessionKey,
          agentId: resolvedId,
          entry,
          workspaceDir,
          homeDir,
          sandboxConfig,
          modelSpec,
        },
        {
          config: this.config,
          subagents: this.subagents,
          skillLoader: this.skillLoader,
          extensionRegistry: this.extensionRegistry,
          toolProvider: this.toolProvider,
          getSandboxExecutor: (p) => this.getSandboxExecutor(p),
        },
      );
      const toolNames = Array.from(new Set(tools.map((tool) => tool.name)));
      const systemPromptText = await buildSystemPrompt({
        homeDir,
        workspaceDir,
        basePrompt: entry?.systemPrompt,
        skills: entry?.skills,
        tools: toolNames,
        sandboxConfig,
        skillLoader: this.skillLoader,
        skillsIndexSynced: this.skillsIndexSynced,
      });
      const piSessionManager = PiSessionManager.inMemory(workspaceDir);
      const piSettingsManager = PiSettingsManager.create(workspaceDir, this.resolvePiAgentDir());
      const created = await createAgentSession({
        cwd: workspaceDir,
        agentDir: this.resolvePiAgentDir(),
        modelRegistry: this.piModelRegistry,
        model,
        tools: [],
        customTools: tools,
        sessionManager: piSessionManager,
        settingsManager: piSettingsManager,
      });
      agent = created.session;
      agent.agent.setSystemPrompt(systemPromptText);
      let persistedContext = Array.isArray(session.context)
        ? (session.context as AgentMessage[])
        : [];
      if (persistedContext.length > 0) {
        const historyLimit = resolveHistoryLimit(this.config, sessionKey);
        if (historyLimit && historyLimit > 0) {
          persistedContext = limitHistoryTurns(persistedContext, historyLimit);
        }
        const pruningConfig = resolveContextPruningConfig(this.config, entry);
        const pruningSettings = computeEffectiveSettings(pruningConfig);
        const pruningResult = pruneContextMessages({
          messages: persistedContext,
          settings: pruningSettings,
          contextWindowTokens: modelSpec.contextWindow ?? 128000,
        });
        if (pruningResult.stats.charsSaved > 0) {
          logger.info(
            {
              sessionKey,
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
          modelRef,
          modelSpec.api,
          modelSpec.provider,
        );
        agent.agent.replaceMessages(sanitizedMessages);
      }
      const thinkingLevel = resolveThinkingLevel({
        config: this.config,
        sessions: this.sessions,
        entry,
        sessionKey,
      });
      if (thinkingLevel) {
        agent.setThinkingLevel(thinkingLevel);
      }
      this.agents.set(sessionKey, agent);
      this.agentModelRefs.set(sessionKey, modelRef);
    }

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
    const persist = options?.persist ?? true;
    if (persist) {
      this.sessions.update(sessionKey, { currentModel: modelRef });
      this.runtimeModelOverrides.delete(sessionKey);
    } else {
      this.runtimeModelOverrides.set(sessionKey, modelRef);
    }
    const agent = this.agents.get(sessionKey);
    if (!agent) {
      return;
    }
    const spec = this.modelRegistry.get(modelRef);
    if (!spec) {
      return;
    }

    const oldModelRef = this.agentModelRefs.get(sessionKey);
    if (oldModelRef) {
      const oldSpec = this.modelRegistry.get(oldModelRef);
      const oldNeedsSanitize = oldSpec ? shouldSanitizeTools(this.config, oldSpec) : false;
      const newNeedsSanitize = shouldSanitizeTools(this.config, spec);
      if (oldNeedsSanitize !== newNeedsSanitize) {
        agent.dispose();
        this.agents.delete(sessionKey);
        this.agentModelRefs.delete(sessionKey);
        return;
      }
    }

    await agent.setModel(this.buildPiModel(spec));
    this.agentModelRefs.set(sessionKey, modelRef);
  }

  clearRuntimeModelOverride(sessionKey: string): void {
    this.runtimeModelOverrides.delete(sessionKey);
  }

  resetSession(sessionKey: string, agentId?: string): void {
    const resolvedAgentId = agentId || this.resolveDefaultAgentId();
    this.sessions.rotateSegment(sessionKey, resolvedAgentId);
    this.disposeRuntimeSession(sessionKey);
  }

  disposeRuntimeSession(sessionKey: string): void {
    const session = this.agents.get(sessionKey);
    if (session) {
      session.dispose();
    }
    this.agents.delete(sessionKey);
    this.agentModelRefs.delete(sessionKey);
    this.runtimeModelOverrides.delete(sessionKey);
    this.channelContextSessions.delete(sessionKey);
  }

  updateSessionContext(sessionKey: string, messages: unknown): void {
    const session = this.sessions.get(sessionKey);
    const modelRef = this.agentModelRefs.get(sessionKey) || session?.currentModel;

    if (Array.isArray(messages) && modelRef) {
      const modelSpec = this.modelRegistry.get(modelRef);
      const sanitized = sanitizePromptInputForModel(
        messages as AgentMessage[],
        modelRef,
        modelSpec?.api,
        modelSpec?.provider,
      );
      this.sessions.update(sessionKey, { context: sanitized });
      return;
    }

    this.sessions.update(sessionKey, { context: messages });
  }

  getSessionMetadata(sessionKey: string): Record<string, unknown> | undefined {
    return this.sessions.get(sessionKey)?.metadata;
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
    const agent = this.agents.get(sessionKey);
    if (!agent) {
      return { success: false, tokensReclaimed: 0, reason: "No active agent session" };
    }

    const messages = agent.messages;
    if (messages.length < 4) {
      return { success: false, tokensReclaimed: 0, reason: "Too few messages to compact" };
    }

    try {
      const result = await agent.compact();

      this.sessions.update(sessionKey, { context: agent.messages });

      return {
        success: true,
        tokensReclaimed: result.tokensBefore,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, tokensReclaimed: 0, reason: msg };
    }
  }

  getContextUsage(sessionKey: string): {
    usedTokens: number;
    totalTokens: number;
    percentage: number;
    messageCount: number;
  } | null {
    const agent = this.agents.get(sessionKey);
    if (!agent) {
      return null;
    }

    const messages = agent.messages;
    const modelRef = this.agentModelRefs.get(sessionKey);
    const modelSpec = modelRef ? this.modelRegistry.get(modelRef) : undefined;
    const totalTokens = modelSpec?.contextWindow ?? 128_000;
    const usedTokens = estimateMessagesTokens(messages);

    return {
      usedTokens,
      totalTokens,
      percentage: Math.round((usedTokens / totalTokens) * 100),
      messageCount: messages.length,
    };
  }

  getContextBreakdown(sessionKey: string): {
    systemPromptTokens: number;
    userMessageTokens: number;
    assistantMessageTokens: number;
    toolResultTokens: number;
    totalTokens: number;
  } | null {
    const agent = this.agents.get(sessionKey);
    if (!agent) {
      return null;
    }

    const messages = agent.messages;
    let system = 0;
    let user = 0;
    let assistant = 0;
    let tool = 0;

    system = Math.ceil((agent.systemPrompt || "").length / 4);
    for (const msg of messages) {
      const tokens = estimateTokens(msg);
      switch (msg.role) {
        case "user":
          user += tokens;
          break;
        case "assistant":
          assistant += tokens;
          break;
        case "toolResult":
          tool += tokens;
          break;
      }
    }

    return {
      systemPromptTokens: system,
      userMessageTokens: user,
      assistantMessageTokens: assistant,
      toolResultTokens: tool,
      totalTokens: system + user + assistant + tool,
    };
  }
}
