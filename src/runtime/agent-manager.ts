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
import { type SandboxConfig, type SandboxProbeResult } from "./sandbox/types";
import { SandboxService } from "./sandbox/service";
import { VibeboxExecutor } from "./sandbox/vibebox-executor";
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
import { createTapeStore, createTapeService, buildMessagesFromTape } from "../tape/integration.js";
import type { TapeMessage } from "../tape/tape-context.js";
import type { TapeService } from "../tape/tape-service.js";
import { TapeStore } from "../tape/tape-store.js";
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
  createSkillLoader,
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
import {
  configureCliBackends,
  ensureCliBackendProviderRegistered,
  listCliBackendModelDefinitions,
} from "./cli-backends";
import { registerRuntimeHook, unregisterRuntimeHook } from "./hooks";
import { loadExternalHooks } from "./hooks/external-loader";
import { ModelRegistry } from "./model-registry";
import { ProviderRegistry } from "./provider-registry";
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

type AgentSkillSummary = {
  name: string;
  description?: string;
};

export type AgentSkillsInventory = {
  enabled: AgentSkillSummary[];
  loadedButDisabled: AgentSkillSummary[];
  missingConfigured: string[];
  allowlistActive: boolean;
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
  private promptToolsBySession = new Map<string, string[]>();
  private skillLoadersByWorkspace = new Map<string, SkillLoader>();
  private modelRegistry: ModelRegistry;
  private providerRegistry: ProviderRegistry;
  private sessions: SessionStore;
  private config: MoziConfig;
  private subagents?: SubagentRegistry;
  private skillLoader?: SkillLoader;
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
    this.skillLoader = createSkillLoader(this.config, this.extensionRegistry);
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

  private syncExtensionHooks() {
    this.clearExtensionHooks();
    const hooks = this.extensionRegistry.collectHooks();
    hooks.forEach((entry, index) => {
      const rawId = entry.hook.id?.trim();
      const id = rawId || `extension:${entry.extensionId}:${entry.hook.hookName}:${index + 1}`;
      const registeredId = registerRuntimeHook(entry.hook.hookName, entry.hook.handler as never, {
        id,
        priority: entry.hook.priority,
      });
      this.extensionHookIds.add(registeredId);
    });
  }

  private initSkillLoader() {
    this.skillLoader = createSkillLoader(this.config, this.extensionRegistry);
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

  private resolveDefaultBaseUrl(api?: string): string | undefined {
    switch (api) {
      case "openai-responses":
      case "openai-chat":
        return "https://api.openai.com/v1";
      case "openai-codex-responses":
        return "https://chatgpt.com/backend-api";
      case "anthropic":
        return "https://api.anthropic.com/v1";
      case "google-generative-ai":
        return "https://generativelanguage.googleapis.com/v1beta";
      case "google-gemini-cli":
        return "https://cloudcode-pa.googleapis.com";
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
    this.skillLoadersByWorkspace.clear();
    this.syncExternalHooks();
    this.syncExtensionHooks();
    configureCliBackends(this.config);
    this.piModelRegistry = this.createPiModelRegistry();
    this.skillsIndexSynced.clear();
    clearMemoryManagerCache();

    disposeAllRuntimeSessions({
      agents: this.agents,
      agentModelRefs: this.agentModelRefs,
      runtimeModelOverrides: this.runtimeModelOverrides,
      channelContextSessions: this.channelContextSessions,
    });
    this.promptMetadataBySession.clear();
    this.promptToolsBySession.clear();
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
    this.initSkillLoader();
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
    const loaded = skillLoader
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
      .filter((skill): skill is AgentSkillSummary => Boolean(skill))
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
    promptModeOverride?: PromptMode;
  }): Promise<void> {
    const { agentId, sessionKey, message, promptModeOverride } = params;
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
    const basePrompt = await buildSystemPrompt({
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

    const channelContext = buildChannelContext(message);
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
    authResolver?: import("./exec-runtime").AuthResolver;
  }): import("./exec-runtime").ExecRuntime {
    // Lazy import to avoid circular dependencies
    const { getProcessRegistry } = require("../process") as {
      getProcessRegistry: () => import("../process/process-registry").ProcessRegistry;
    };
    const { createSandboxBoundary } = require("./sandbox/config") as {
      createSandboxBoundary: (workspaceDir: string, config?: SandboxConfig, allowlist?: string[]) => import("./sandbox/config").SandboxBoundary;
    };

    const { ExecRuntime } = require("./exec-runtime") as {
      ExecRuntime: new (
        registry: import("../process/process-registry").ProcessRegistry,
        boundary: import("./sandbox/config").SandboxBoundary,
        authResolver?: import("./exec-runtime").AuthResolver,
        allowedSecrets?: string[],
        vibeboxExecutor?: import("./sandbox/vibebox-executor").VibeboxExecutor,
      ) => import("./exec-runtime").ExecRuntime;
    };

    const boundary = createSandboxBoundary(
      params.workspaceDir,
      params.sandboxConfig,
      params.allowlist,
    );

    const registry = getProcessRegistry();

    // When the effective boundary mode is vibebox, inject a VibeboxExecutor so
    // ExecRuntime can delegate execution to the external vibebox binary bridge.
    let vibeboxExecutor: import("./sandbox/vibebox-executor").VibeboxExecutor | undefined;
    if (boundary.mode === "vibebox") {
      const { VibeboxExecutor } = require("./sandbox/vibebox-executor") as {
        VibeboxExecutor: new (params: {
          config?: import("./sandbox/types").SandboxVibeboxConfig;
          defaultProvider?: "off" | "apple-vm" | "docker";
        }) => import("./sandbox/vibebox-executor").VibeboxExecutor;
      };
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
    if (!tapeService) return null;
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

  /**
   * Returns (or lazily creates) a TapeService for the given session.
   * Returns null if the tape store cannot be resolved (e.g. no homeDir configured).
   */
  getTapeService(sessionKey: string): TapeService | null {
    const existing = this.tapeServices.get(sessionKey);
    if (existing) {
      return existing;
    }

    const homeDir = this.config.paths?.baseDir ?? path.join(os.homedir(), ".mozi");
    const workspaceDir = os.homedir(); // workspace-agnostic store at home level

    if (!this.tapeStore) {
      try {
        this.tapeStore = createTapeStore(homeDir, workspaceDir);
      } catch (err) {
        logger.warn({ err }, "TapeStore creation failed; tape dual-write disabled");
        return null;
      }
    }

    try {
      // tapeName format: session:{sessionKey}
      const tapeName = `session:${sessionKey}`;
      const service = createTapeService(this.tapeStore, tapeName);
      this.tapeServices.set(sessionKey, service);
      return service;
    } catch (err) {
      logger.warn({ sessionKey, err }, "TapeService creation failed; tape dual-write disabled for session");
      return null;
    }
  }

  /**
   * Returns the shared TapeStore, lazily creating it if needed.
   * Returns null if the store cannot be resolved (e.g. no homeDir configured).
   */
  getTapeStore(): TapeStore | null {
    if (this.tapeStore) {
      return this.tapeStore;
    }

    const homeDir = this.config.paths?.baseDir ?? path.join(os.homedir(), ".mozi");
    const workspaceDir = os.homedir();

    try {
      this.tapeStore = createTapeStore(homeDir, workspaceDir);
      return this.tapeStore;
    } catch (err) {
      logger.warn({ err }, "TapeStore creation failed; tape fork/merge disabled");
      return null;
    }
  }
}
