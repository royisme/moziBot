import os from "node:os";
import path from "node:path";
import { type AgentTool, type ThinkingLevel } from "@mariozechner/pi-agent-core";
import type { Api, Context, Model, StreamFunction, StreamOptions } from "@mariozechner/pi-ai";
import { streamSimple } from "@mariozechner/pi-ai";
import {
  AuthStorage,
  type AgentSession,
  ModelRegistry as PiCodingModelRegistry,
} from "@mariozechner/pi-coding-agent";
import { type BootstrapState } from "../agents/home";
import { SkillLoader } from "../agents/skills/loader";
import type { MoziConfig } from "../config";
import { type ExtensionRegistry } from "../extensions";
import { logger } from "../logger";
import { clearMemoryManagerCache } from "../memory";
import { getProcessRegistry } from "../process";
import { createTapeStore, createTapeService, buildMessagesFromTape } from "../tape/integration.js";
import type { TapeMessage } from "../tape/tape-context.js";
import type { TapeService } from "../tape/tape-service.js";
import { TapeStore } from "../tape/tape-store.js";
import type { InboundMessage } from "./adapters/channels/types";
import { createAndInitializeAgentSession } from "./agent-manager/agent-session-factory";
import { resolveOrCreateAgentSession } from "./agent-manager/agent-session-orchestrator";
// Extracted modules
import {
  type AgentEntry,
  resolveWorkspaceDir,
  resolveHomeDir,
  resolveSandboxConfig,
  resolvePromptTimeoutMs as resolvePromptTimeoutMsFromConfig,
  resolveSubagentPromptMode,
} from "./agent-manager/config-resolver";
import {
  compactSession as compactSessionMetric,
  getContextBreakdown as getContextBreakdownMetric,
  getContextUsage as getContextUsageMetric,
} from "./agent-manager/context-metrics";
import {
  createExtensionRegistry,
  createSkillLoaderForContext,
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
import { applySystemPromptOverrideToSession } from "./agent-manager/system-prompt-override";
import { resolveThinkingLevel } from "./agent-manager/thinking-resolver";
import { AuthProfileStoreAdapter, type AuthProfileFailureReason } from "./auth-profiles";
import {
  configureCliBackends,
  ensureCliBackendProviderRegistered,
  listCliBackendModelDefinitions,
} from "./cli-backends";
import { isAuthOrBillingError, isTransientError } from "./core/error-policy";
import { ExecRuntime, type AuthResolver } from "./exec-runtime";
import { registerRuntimeHook, unregisterRuntimeHook } from "./hooks";
import { loadExternalHooks } from "./hooks/external-loader";
import type { ChannelDispatcherBridge } from "./host/message-handler/contract";
import { buildCurrentChannelContextFromInbound } from "./host/message-handler/services/current-channel-context";
import { ModelRegistry } from "./model-registry";
import { ProviderRegistry } from "./provider-registry";
import {
  normalizePiInputCapabilities,
  registerConfiguredPiProviders,
} from "./providers/pi-registration";
import { createSandboxBoundary } from "./sandbox/config";
import { SandboxService } from "./sandbox/service";
import { type SandboxConfig, type SandboxProbeResult } from "./sandbox/types";
import { VibeboxExecutor } from "./sandbox/vibebox-executor";
import { SessionStore } from "./session-store";
import type { SubagentRegistry } from "./subagent-registry";
import type { ModelSpec } from "./types";

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

type AgentSkillSummary = {
  name: string;
  description: string | undefined;
};

export type AgentSkillsInventory = {
  enabled: AgentSkillSummary[];
  loadedButDisabled: AgentSkillSummary[];
  missingConfigured: string[];
  allowlistActive: boolean;
};

function isAgentEntry(value: unknown): value is AgentEntry {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * Creates a stream function wrapper that defaults to "auto" transport
 * (WebSocket-first, SSE fallback) for OpenAI Codex providers.
 * When transport is explicitly set in options it overrides the default.
 */
export function inferAuthProfileFailureReason(error: unknown): AuthProfileFailureReason {
  const message =
    error instanceof Error ? error.message : typeof error === "string" ? error : "unknown";
  const lower = message.toLowerCase();
  if (
    lower.includes("402") ||
    lower.includes("billing") ||
    lower.includes("quota exceeded") ||
    lower.includes("insufficient")
  ) {
    return "billing";
  }
  if (
    lower.includes("401") ||
    lower.includes("403") ||
    lower.includes("unauthorized") ||
    lower.includes("forbidden") ||
    lower.includes("invalid api key") ||
    lower.includes("authentication failed")
  ) {
    return "auth_permanent";
  }
  if (lower.includes("rate limit") || lower.includes("429")) {
    return "rate_limit";
  }
  if (
    lower.includes("overloaded") ||
    lower.includes("503") ||
    lower.includes("service unavailable")
  ) {
    return "overloaded";
  }
  if (isAuthOrBillingError(message)) {
    return "auth_permanent";
  }
  if (isTransientError(message)) {
    return "unknown";
  }
  return "unknown";
}

export function createCodexDefaultTransportWrapper(
  baseStreamFn?: StreamFunction,
  params?: {
    authProfiles?: AuthProfileStoreAdapter;
    profileId?: string;
  },
): StreamFunction {
  const underlying = baseStreamFn ?? streamSimple;
  return (model: Model<Api>, context: Context, options?: StreamOptions) => {
    try {
      const result = underlying(model, context, {
        ...options,
        transport: options?.transport ?? "auto",
      });
      if (params?.authProfiles && params.profileId) {
        params.authProfiles.markUsed(params.profileId);
        params.authProfiles.markGood(params.profileId);
      }
      return result;
    } catch (error) {
      if (params?.authProfiles && params.profileId) {
        params.authProfiles.markFailure(params.profileId, inferAuthProfileFailureReason(error));
      }
      throw error;
    }
  };
}

export class AgentManager {
  private agents = new Map<string, AgentSession>();
  private agentModelRefs = new Map<string, string>();
  private runtimeModelOverrides = new Map<string, string>();
  private channelContextSessions = new Set<string>();
  private promptMetadataBySession = new Map<string, PromptBuildMetadata>();
  private promptToolsBySession = new Map<string, string[]>();
  private basePromptBySession = new Map<string, string>();
  private skillLoadersByWorkspace = new Map<string, SkillLoader>();
  private modelRegistry: ModelRegistry;
  private providerRegistry: ProviderRegistry;
  private sessions: SessionStore;
  private config: MoziConfig;
  private subagents?: SubagentRegistry;
  private skillsIndexSynced = new Set<string>();
  private extensionRegistry: ExtensionRegistry;
  private extensionHookIds = new Set<string>();
  private externalHookIds = new Set<string>();
  private piModelRegistry: PiCodingModelRegistry;
  private toolProvider?: (params: {
    sessionKey: string;
    agentId: string;
    workspaceDir: string;
    homeDir: string;
    sandboxConfig?: SandboxConfig;
  }) => Promise<AgentTool[]> | AgentTool[];
  // Tape system: per-workspace store and per-session service registry
  private tapeStore: TapeStore | undefined;
  private tapeServices = new Map<string, TapeService>();
  private sessionContexts = new Map<string, { channel: ChannelDispatcherBridge; peerId: string }>();

  constructor(params: {
    config: MoziConfig;
    modelRegistry: ModelRegistry;
    providerRegistry: ProviderRegistry;
    sessions: SessionStore;
  }) {
    this.config = params.config;
    ensureCliBackendProviderRegistered();
    configureCliBackends(this.config);
    this.modelRegistry = params.modelRegistry;
    this.providerRegistry = params.providerRegistry;
    this.sessions = params.sessions;
    this.extensionRegistry = createExtensionRegistry(this.config);
    this.syncExternalHooks();
    this.syncExtensionHooks();
    this.piModelRegistry = this.createPiModelRegistry();
  }

  private clearExternalHooks() {
    for (const hookId of this.externalHookIds) {
      unregisterRuntimeHook(hookId);
    }
    this.externalHookIds.clear();
  }

  private syncExternalHooks() {
    this.clearExternalHooks();
    const hookIds = loadExternalHooks(this.config);
    hookIds.forEach((id) => this.externalHookIds.add(id));
  }

  private clearExtensionHooks() {
    for (const hookId of this.extensionHookIds) {
      unregisterRuntimeHook(hookId);
    }
    this.extensionHookIds.clear();
  }

  private registerExtensionHook(
    entry: ReturnType<ExtensionRegistry["collectHooks"]>[number],
    index: number,
  ): void {
    const rawId = entry.hook.id?.trim();
    const id = rawId || `extension:${entry.extensionId}:${entry.hook.hookName}:${index + 1}`;
    const registeredId = registerRuntimeHook(entry.hook.hookName, entry.hook.handler, {
      id,
      priority: entry.hook.priority,
    });
    this.extensionHookIds.add(registeredId);
  }

  private syncExtensionHooks() {
    this.clearExtensionHooks();
    const hooks = this.extensionRegistry.collectHooks();
    hooks.forEach((entry, index) => {
      this.registerExtensionHook(entry, index);
    });
  }

  private clearSkillLoaderCache() {
    this.skillLoadersByWorkspace.clear();
  }

  private getSkillLoaderForWorkspace(workspaceDir: string): SkillLoader {
    const key = path.resolve(workspaceDir);
    const existing = this.skillLoadersByWorkspace.get(key);
    if (existing) {
      return existing;
    }
    const loader = createSkillLoaderForContext(this.config, this.extensionRegistry, {
      workspaceDir: key,
    });
    this.skillLoadersByWorkspace.set(key, loader);
    return loader;
  }

  private resolvePiAgentDir(): string {
    const baseDir = this.config.paths?.baseDir || path.join(os.homedir(), ".mozi");
    return path.join(baseDir, "pi-agent");
  }

  private registerCliBackendProviders(registry: PiCodingModelRegistry): void {
    const cliProviders = listCliBackendModelDefinitions(this.config);
    for (const entry of cliProviders) {
      registry.registerProvider(entry.providerId, {
        api: "cli-backend",
        baseUrl: "cli://local",
        apiKey: "LOCAL_CLI_KEY",
        models: entry.models.map((model) => ({
          id: model.id,
          name: model.name ?? model.id,
          api: "cli-backend",
          reasoning: model.reasoning ?? false,
          input: normalizePiInputCapabilities(model.input),
          contextWindow: model.contextWindow ?? 128000,
          maxTokens: model.maxTokens ?? 8192,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          headers: model.headers,
        })),
      });
    }
  }

  private createPiModelRegistry(): PiCodingModelRegistry {
    const agentDir = this.resolvePiAgentDir();
    const authStorage = AuthStorage.create(path.join(agentDir, "auth.json"));
    const registry = new PiCodingModelRegistry(authStorage, undefined);
    registerConfiguredPiProviders({
      registry,
      providers: this.providerRegistry.list(),
      authProfiles: new AuthProfileStoreAdapter(),
      createCodexDefaultTransportWrapper,
    });
    this.registerCliBackendProviders(registry);
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
    void lifecycle.skillLoader;
    this.skillLoadersByWorkspace.clear();
    this.syncExternalHooks();
    this.syncExtensionHooks();
    configureCliBackends(this.config);
    this.piModelRegistry = this.createPiModelRegistry();
    this.skillsIndexSynced.clear();
    this.tapeStore = undefined;
    this.tapeServices.clear();
    clearMemoryManagerCache();

    disposeAllRuntimeSessions({
      agents: this.agents,
      agentModelRefs: this.agentModelRefs,
      runtimeModelOverrides: this.runtimeModelOverrides,
      channelContextSessions: this.channelContextSessions,
    });
    this.promptMetadataBySession.clear();
    this.promptToolsBySession.clear();
    this.basePromptBySession.clear();
  }

  setSubagentRegistry(registry: SubagentRegistry) {
    this.subagents = registry;
  }

  getExtensionRegistry(): ExtensionRegistry {
    return this.extensionRegistry;
  }

  async dispatchExtensionCommand(params: {
    commandName: string;
    args: string;
    sessionKey: string;
    agentId: string;
    peerId: string;
    channelId: string;
    message: unknown;
    sendReply: (text: string) => Promise<void>;
  }): Promise<boolean> {
    return await this.extensionRegistry.executeCommand({
      ...params,
      onError: (error, meta) => {
        logger.warn(
          {
            extensionId: meta.extensionId,
            commandName: meta.commandName,
            error,
          },
          "Extension command failed",
        );
      },
    });
  }

  async initExtensionsAsync(): Promise<void> {
    await initExtensions(this.config, this.extensionRegistry);
    this.syncExtensionHooks();
    this.clearSkillLoaderCache();
  }

  async shutdownExtensions(): Promise<void> {
    this.clearExternalHooks();
    this.clearExtensionHooks();
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
      .filter(([key, entry]) => key !== "defaults" && isAgentEntry(entry))
      .map(([id, entry]) => ({ id, entry }));
  }

  resolveDefaultAgentId(): string {
    const entries = this.listAgentEntries();
    const mainAgent = entries.find((e) => e.entry.main === true);
    if (mainAgent?.id) {
      return mainAgent.id;
    }
    return entries[0]?.id || "mozi";
  }

  getAgentEntry(agentId: string): AgentEntry | undefined {
    if (agentId === "defaults") {
      return undefined;
    }
    const agents = this.config.agents;
    if (!agents || !(agentId in agents)) {
      return undefined;
    }
    const candidate = agents[agentId as keyof typeof agents];
    return isAgentEntry(candidate) ? candidate : undefined;
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

      let result: SandboxProbeResult;
      if (vibeboxEnabled) {
        const vibebox = new VibeboxExecutor({
          config: sandboxConfig?.apple?.vibebox,
          defaultProvider: mode,
        });
        result = await vibebox.probe();
      } else {
        const service = new SandboxService(sandboxConfig!);
        result = await service.probe();
      }
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

  getHomeDir(agentId: string): string | undefined {
    const entry = this.getAgentEntry(agentId);
    if (!entry) {
      return undefined;
    }
    return resolveHomeDir(this.config, agentId, entry);
  }

  async listAvailableSkills(
    agentId: string,
  ): Promise<Array<{ name: string; description?: string }>> {
    const inventory = await this.listSkillsInventory(agentId);
    return inventory.enabled;
  }

  async listSkillsInventory(agentId: string): Promise<AgentSkillsInventory> {
    const entry = this.getAgentEntry(agentId);
    const workspaceDir = resolveWorkspaceDir(this.config, agentId, entry);
    const skillLoader = this.getSkillLoaderForWorkspace(workspaceDir);
    await skillLoader.loadAll();
    const loaded: AgentSkillSummary[] = skillLoader
      .list()
      .map((skill) => ({ name: skill.name, description: skill.description?.trim() || undefined }))
      .toSorted((a, b) => a.name.localeCompare(b.name));
    const configured = (entry?.skills ?? []).map((name) => name.trim()).filter((name) => !!name);
    const allowlistActive = configured.length > 0;
    if (!allowlistActive) {
      return {
        enabled: loaded,
        loadedButDisabled: [],
        missingConfigured: [],
        allowlistActive: false,
      };
    }
    const configuredSet = new Set(configured);
    const loadedByName = new Map(loaded.map((skill) => [skill.name, skill]));
    const enabled = configured
      .map((name) => loadedByName.get(name))
      .filter((skill): skill is AgentSkillSummary => skill !== undefined)
      .toSorted((a, b) => a.name.localeCompare(b.name));
    const loadedButDisabled = loaded
      .filter((skill) => !configuredSet.has(skill.name))
      .toSorted((a, b) => a.name.localeCompare(b.name));
    const missingConfigured = configured
      .filter((name, index) => configured.indexOf(name) === index && !loadedByName.has(name))
      .toSorted((a, b) => a.localeCompare(b));
    return {
      enabled,
      loadedButDisabled,
      missingConfigured,
      allowlistActive: true,
    };
  }

  async ensureChannelContext(params: {
    sessionKey: string;
    agentId: string;
    message: InboundMessage;
    channel: import("./adapters/channels/plugin").ChannelPlugin;
    promptModeOverride?: PromptMode;
  }): Promise<void> {
    const { agentId, sessionKey, message, channel, promptModeOverride } = params;
    const entry = this.getAgentEntry(agentId);
    const workspaceDir = resolveWorkspaceDir(this.config, agentId, entry);
    const homeDir = resolveHomeDir(this.config, agentId, entry);
    const sandboxConfig = resolveSandboxConfig(this.config, entry);
    const requestedPromptMode =
      promptModeOverride ?? this.promptMetadataBySession.get(sessionKey)?.mode;

    const { agent } = await this.getAgent(sessionKey, agentId, {
      promptMode: requestedPromptMode,
    });

    const promptMode =
      promptModeOverride ??
      this.promptMetadataBySession.get(sessionKey)?.mode ??
      requestedPromptMode;
    const tools = this.promptToolsBySession.get(sessionKey);
    const cachedMode = this.promptMetadataBySession.get(sessionKey)?.mode;
    const cachedBase = this.basePromptBySession.get(sessionKey);
    let basePrompt: string;
    if (cachedBase !== undefined && cachedMode === promptMode) {
      basePrompt = cachedBase;
    } else {
      basePrompt = await buildSystemPrompt({
        homeDir,
        workspaceDir,
        basePrompt: entry?.systemPrompt,
        skills: entry?.skills,
        tools,
        sandboxConfig,
        skillLoader: this.getSkillLoaderForWorkspace(workspaceDir),
        skillsIndexSynced: this.skillsIndexSynced,
        mode: promptMode,
        onMetadata: (metadata) => {
          this.promptMetadataBySession.set(sessionKey, metadata);
          logger.debug(
            {
              sessionKey,
              agentId,
              promptMode: metadata.mode,
              promptHash: metadata.promptHash,
              loadedFiles: metadata.loadedFiles,
              skippedFiles: metadata.skippedFiles,
            },
            "Prompt files resolved",
          );
        },
      });
      this.basePromptBySession.set(sessionKey, basePrompt);
    }

    const currentChannel = buildCurrentChannelContextFromInbound({
      plugin: channel,
      message,
      sessionKey,
    });
    const registeredTools = this.promptToolsBySession.get(sessionKey);
    const channelContext = buildChannelContext(message, currentChannel, registeredTools);
    const nextPrompt = channelContext ? `${basePrompt}\n\n${channelContext}` : basePrompt;
    if (agent.systemPrompt !== nextPrompt) {
      applySystemPromptOverrideToSession(agent, nextPrompt);
    }
    this.channelContextSessions.add(sessionKey);
  }

  private getExecRuntime(params: {
    workspaceDir: string;
    sandboxConfig?: SandboxConfig;
    allowlist?: string[];
    allowedSecrets?: string[];
    authResolver?: AuthResolver;
  }): ExecRuntime {
    const boundary = createSandboxBoundary(
      params.workspaceDir,
      params.sandboxConfig,
      params.allowlist,
    );

    const registry = getProcessRegistry();

    let vibeboxExecutor: VibeboxExecutor | undefined;
    if (boundary.mode === "vibebox") {
      const sandboxMode = params.sandboxConfig?.mode ?? "apple-vm";
      vibeboxExecutor = new VibeboxExecutor({
        config: params.sandboxConfig?.apple?.vibebox,
        defaultProvider: sandboxMode === "docker" ? "docker" : "apple-vm",
      });
    }

    return new ExecRuntime(
      registry,
      boundary,
      params.authResolver,
      params.allowedSecrets,
      vibeboxExecutor,
    );
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
    const model: Model<Api> = {
      id: spec.id,
      name: spec.id,
      api: spec.api,
      provider: spec.provider ?? "unknown",
      baseUrl: spec.baseUrl ?? "",
      reasoning: spec.reasoning ?? false,
      input: normalizePiInputCapabilities(spec.input),
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: spec.contextWindow ?? 128000,
      maxTokens: spec.maxTokens ?? 8192,
      headers: spec.headers,
    };
    return model;
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
      modelRegistry: this.modelRegistry,
      resolveDefaultAgentId: () => this.resolveDefaultAgentId(),
      getAgentEntry: (targetAgentId) => this.getAgentEntry(targetAgentId),
      resolveAgentModelRef: (targetAgentId, agentEntry) =>
        this.resolveAgentModelRef(targetAgentId, agentEntry),
      setSessionModel: async (sk, mRef, opts) => await this.setSessionModel(sk, mRef, opts),
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
          skillLoader: this.getSkillLoaderForWorkspace(params.workspaceDir),
          extensionRegistry: this.extensionRegistry,
          skillsIndexSynced: this.skillsIndexSynced,
          toolProvider: this.toolProvider,
          getExecRuntime: (p) => this.getExecRuntime(p),
          onToolsResolved: (toolNames) => {
            this.promptToolsBySession.set(sessionKey, toolNames);
          },
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
      skillLoader: this.getSkillLoaderForWorkspace(params.workspaceDir),
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

  registerSessionContext(
    sessionKey: string,
    ctx: {
      channel: ChannelDispatcherBridge;
      peerId: string;
      route?: {
        channelId: string;
        peerId: string;
        peerType: "dm" | "group" | "channel";
        accountId?: string;
        threadId?: string;
        replyToId?: string;
      };
    },
  ): void {
    this.sessionContexts.set(sessionKey, ctx);
  }

  getSessionContext(sessionKey: string):
    | {
        channel: ChannelDispatcherBridge;
        peerId: string;
        route?: {
          channelId: string;
          peerId: string;
          peerType: "dm" | "group" | "channel";
          accountId?: string;
          threadId?: string;
          replyToId?: string;
        };
      }
    | undefined {
    return this.sessionContexts.get(sessionKey);
  }

  clearSessionContext(sessionKey: string): void {
    this.sessionContexts.delete(sessionKey);
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
    this.promptToolsBySession.delete(sessionKey);
    this.basePromptBySession.delete(sessionKey);
    this.sessionContexts.delete(sessionKey);
    this.tapeServices.delete(sessionKey);
  }

  getSessionMetadata(sessionKey: string): Record<string, unknown> | undefined {
    return this.sessions.get(sessionKey)?.metadata;
  }

  getPromptMetadata(sessionKey: string): PromptBuildMetadata | undefined {
    return this.promptMetadataBySession.get(sessionKey);
  }

  invalidateBasePromptCache(sessionKey?: string): void {
    if (sessionKey) {
      this.basePromptBySession.delete(sessionKey);
    } else {
      this.basePromptBySession.clear();
    }
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
      getTapeService: (key) => this.getTapeService(key),
    });
  }

  /**
   * Reconstruct LLM messages from the tape for a session, using only entries
   * after the last anchor (i.e., the most recent compaction boundary).
   * Returns null if no tape service is available for the session.
   * This is an alternative context source that will replace session context in TAPE-4.
   */
  getMessagesFromTape(sessionKey: string): TapeMessage[] | null {
    const tapeService = this.getTapeService(sessionKey);
    if (!tapeService) {
      return null;
    }
    return buildMessagesFromTape(tapeService);
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

  private ensureTapeStore(logMessage: string): TapeStore | null {
    if (this.tapeStore) {
      return this.tapeStore;
    }

    const homeDir = this.config.paths?.baseDir ?? path.join(os.homedir(), ".mozi");

    try {
      this.tapeStore = createTapeStore(homeDir, homeDir);
      return this.tapeStore;
    } catch (err) {
      logger.warn({ err }, logMessage);
      return null;
    }
  }

  /**
   * Returns (or lazily creates) a TapeService for the given session.
   * Returns null if the tape store cannot be resolved (e.g. no homeDir configured).
   */
  getTapeService(sessionKey: string): TapeService | null {
    const existing = this.tapeServices.get(sessionKey);
    if (existing) {
      return existing;
    }

    const tapeStore = this.ensureTapeStore("TapeStore creation failed; tape dual-write disabled");
    if (!tapeStore) {
      return null;
    }

    try {
      const tapeName = `session:${sessionKey}`;
      const service = createTapeService(tapeStore, tapeName);
      this.tapeServices.set(sessionKey, service);
      return service;
    } catch (err) {
      logger.warn(
        { sessionKey, err },
        "TapeService creation failed; tape dual-write disabled for session",
      );
      return null;
    }
  }

  /**
   * Returns the shared TapeStore, lazily creating it if needed.
   * Returns null if the store cannot be resolved (e.g. no homeDir configured).
   */
  getTapeStore(): TapeStore | null {
    return this.ensureTapeStore("TapeStore creation failed; tape fork/merge disabled");
  }
}
