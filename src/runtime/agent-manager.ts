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
  checkBootstrapState,
  buildContextWithBootstrap,
  type BootstrapState,
} from "../agents/home";
import { SkillLoader } from "../agents/skills/loader";
import { loadWorkspaceFiles, buildWorkspaceContext } from "../agents/workspace";
import { type ExtensionRegistry, initExtensionsAsync, loadExtensions } from "../extensions";
import { logger } from "../logger";
import {
  clearMemoryManagerCache,
  getMemoryLifecycleOrchestrator,
  getMemoryManager,
} from "../memory";
import { createRuntimeSecretBroker } from "./auth/broker";
import {
  resolveContextWindowInfo,
  evaluateContextWindowGuard,
  CONTEXT_WINDOW_HARD_MIN_TOKENS,
  CONTEXT_WINDOW_WARN_BELOW_TOKENS,
  limitHistoryTurns,
  resolveHistoryLimitFromSessionKey,
  estimateTokens,
  estimateMessagesTokens,
} from "./context-management";
import {
  pruneContextMessages,
  computeEffectiveSettings,
  type ContextPruningConfig,
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
import { createExecTool } from "./sandbox/tool";
import { sanitizeTools } from "./schema-sanitizer";
import { SessionStore } from "./session-store";
import { createSkillsNoteTool } from "./skills-note";
import { filterTools, resolveToolAllowList } from "./tool-selection";
import { createMemoryTools, createPiCodingTools, createSubagentTool } from "./tools";

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

type AgentModelConfig = {
  primary?: string;
  fallbacks?: string[];
  vision?: string;
  visionFallbacks?: string[];
  audio?: string;
  audioFallbacks?: string[];
  video?: string;
  videoFallbacks?: string[];
  file?: string;
  fileFallbacks?: string[];
};

type AgentEntry = {
  name?: string;
  main?: boolean;
  home?: string;
  workspace?: string;
  systemPrompt?: string;
  model?: unknown;
  skills?: string[];
  tools?: string[];
  subagents?: { allow?: string[] };
  sandbox?: unknown;
  exec?: { allowlist?: string[]; allowedSecrets?: string[] };
  heartbeat?: { enabled?: boolean; every?: string; prompt?: string };
  thinking?: ThinkingLevel;
  output?: {
    showThinking?: boolean;
    showToolCalls?: "off" | "summary";
  };
  lifecycle?: {
    control?: {
      model?: string;
      fallback?: string[];
    };
  };
};

const DEFAULT_TOOL_NAMES = [
  "read",
  "edit",
  "write",
  "grep",
  "find",
  "ls",
  "memory_search",
  "memory_get",
  "sessions_list",
  "sessions_history",
  "sessions_send",
  "sessions_spawn",
  "schedule_continuation",
  "subagent_run",
  "skills_note",
  "exec",
];

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
        // Skip providers without baseUrl and no known default
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
    // Shut down existing extension resources before rebuilding
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

  /**
   * Initialize async extension sources and register their tools.
   * Call this once during startup, after construction.
   */
  async initExtensionsAsync(): Promise<void> {
    await initExtensionsAsync(this.config.extensions, this.extensionRegistry);
  }

  /**
   * Shut down all extension resources.
   * Call this during graceful shutdown.
   */
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
      const sandboxConfig = this.resolveSandboxConfig(id, entry);
      const mode = sandboxConfig?.mode ?? "off";
      const vibeboxEnabled =
        sandboxConfig?.apple?.backend === "vibebox" ||
        sandboxConfig?.apple?.vibebox?.enabled === true;
      if (mode !== "docker" && mode !== "apple-vm" && !vibeboxEnabled) {
        continue;
      }
      const executor = this.getSandboxExecutor({
        sandboxConfig,
        allowlist: this.resolveExecAllowlist(entry),
      });
      const result = await executor.probe();
      reports.push({ agentId: id, result });
    }
    return reports;
  }

  private resolveWorkspaceDir(agentId: string, entry?: AgentEntry): string {
    if (entry?.workspace) {
      return entry.workspace;
    }
    const baseDir = this.config.paths?.baseDir;
    if (baseDir) {
      return path.join(baseDir, "agents", agentId, "workspace");
    }
    return path.join("./workspace", agentId);
  }

  getWorkspaceDir(agentId: string): string | undefined {
    const entry = this.getAgentEntry(agentId);
    if (!entry) {
      return undefined;
    }
    return this.resolveWorkspaceDir(agentId, entry);
  }

  private resolveHomeDir(agentId: string, entry?: AgentEntry): string {
    if (entry?.home) {
      return entry.home;
    }
    const baseDir = this.config.paths?.baseDir;
    if (baseDir) {
      return path.join(baseDir, "agents", agentId, "home");
    }
    return path.join(".", "agents", agentId, "home");
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

  private buildChannelContext(message: InboundMessage): string {
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

  async ensureChannelContext(params: {
    sessionKey: string;
    agentId: string;
    message: InboundMessage;
  }): Promise<void> {
    if (this.channelContextSessions.has(params.sessionKey)) {
      return;
    }
    const { agent } = await this.getAgent(params.sessionKey, params.agentId);
    const context = this.buildChannelContext(params.message);
    if (!context) {
      return;
    }
    agent.agent.setSystemPrompt(`${agent.systemPrompt}\n\n${context}`);
    this.channelContextSessions.add(params.sessionKey);
  }

  private resolveSandboxConfig(agentId: string, entry?: AgentEntry): SandboxConfig | undefined {
    const defaults = (this.config.agents?.defaults as { sandbox?: SandboxConfig } | undefined)
      ?.sandbox;
    const override = entry?.sandbox as SandboxConfig | undefined;
    if (!defaults && !override) {
      return undefined;
    }
    return {
      ...defaults,
      ...override,
      docker: { ...defaults?.docker, ...override?.docker },
      apple: { ...defaults?.apple, ...override?.apple },
    };
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

  private buildSandboxPrompt(params: {
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

  private buildToolsSection(tools?: string[]): string | null {
    if (!tools || tools.length === 0) {
      return null;
    }
    const lines = ["# Tools", `Enabled tools: ${tools.join(", ")}`];
    return lines.join("\n");
  }

  private buildSkillsSection(skillsPrompt: string, tools?: string[]): string {
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

  private normalizeModelConfig(raw: unknown): AgentModelConfig | undefined {
    if (!raw) {
      return undefined;
    }
    if (typeof raw === "string") {
      return { primary: raw };
    }
    if (typeof raw === "object") {
      const primary = (raw as { primary?: string }).primary;
      const fallbacks = (raw as { fallbacks?: string[] }).fallbacks;
      const vision = (raw as { vision?: string }).vision;
      const visionFallbacks = (raw as { visionFallbacks?: string[] }).visionFallbacks;
      const audio = (raw as { audio?: string }).audio;
      const audioFallbacks = (raw as { audioFallbacks?: string[] }).audioFallbacks;
      const video = (raw as { video?: string }).video;
      const videoFallbacks = (raw as { videoFallbacks?: string[] }).videoFallbacks;
      const file = (raw as { file?: string }).file;
      const fileFallbacks = (raw as { fileFallbacks?: string[] }).fileFallbacks;
      return {
        primary,
        fallbacks,
        vision,
        visionFallbacks,
        audio,
        audioFallbacks,
        video,
        videoFallbacks,
        file,
        fileFallbacks,
      };
    }
    return undefined;
  }

  private resolveAgentModelRef(agentId: string, entry?: AgentEntry): string | undefined {
    const modelCfg = this.normalizeModelConfig(entry?.model);
    if (modelCfg?.primary) {
      return modelCfg.primary;
    }

    const defaults = this.normalizeModelConfig(this.config.agents?.defaults?.model);
    return defaults?.primary;
  }

  private resolveThinkingLevel(entry?: AgentEntry): ThinkingLevel | undefined {
    const defaults =
      (this.config.agents?.defaults as { thinking?: ThinkingLevel } | undefined)?.thinking ||
      undefined;
    return entry?.thinking ?? defaults;
  }

  private resolveContextPruningConfig(entry?: AgentEntry): ContextPruningConfig | undefined {
    const defaults = (
      this.config.agents?.defaults as { contextPruning?: ContextPruningConfig } | undefined
    )?.contextPruning;
    const agentConfig = (entry as { contextPruning?: ContextPruningConfig } | undefined)
      ?.contextPruning;
    if (!defaults && !agentConfig) {
      return undefined;
    }
    return { ...defaults, ...agentConfig };
  }

  private resolveHistoryLimit(sessionKey: string): number | undefined {
    const channelMatch = sessionKey.match(/^agent:[^:]+:([^:]+):/);
    const channelId = channelMatch?.[1];
    if (!channelId) {
      return undefined;
    }
    const channelConfig = (
      this.config.channels as
        | Record<
            string,
            {
              dmHistoryLimit?: number;
              dms?: Record<string, { historyLimit?: number }>;
            }
          >
        | undefined
    )?.[channelId];
    return resolveHistoryLimitFromSessionKey(sessionKey, channelConfig);
  }

  private resolveToolAllowList(entry?: AgentEntry): string[] {
    const defaults = (this.config.agents?.defaults as { tools?: string[] } | undefined)?.tools;
    return resolveToolAllowList({
      agentTools: entry?.tools,
      defaultTools: defaults,
      fallbackTools: DEFAULT_TOOL_NAMES,
      requiredTools: ["exec"],
    });
  }

  private resolveExecAllowlist(entry?: AgentEntry): string[] | undefined {
    const defaults = (
      this.config.agents?.defaults as { exec?: { allowlist?: string[] } } | undefined
    )?.exec;
    return entry?.exec?.allowlist ?? defaults?.allowlist;
  }

  private resolveExecAllowedSecrets(entry?: AgentEntry): string[] {
    const defaults = (
      this.config.agents?.defaults as { exec?: { allowedSecrets?: string[] } } | undefined
    )?.exec;
    return entry?.exec?.allowedSecrets ?? defaults?.allowedSecrets ?? [];
  }

  private async buildTools(params: {
    sessionKey: string;
    agentId: string;
    entry?: AgentEntry;
    workspaceDir: string;
    homeDir: string;
    sandboxConfig?: SandboxConfig;
    modelSpec: ModelSpec;
  }): Promise<AgentTool[]> {
    const allowList = this.resolveToolAllowList(params.entry);
    const allowSet = new Set(allowList);
    const tools: AgentTool[] = [];

    if (this.subagents && allowSet.has("subagent_run")) {
      tools.push(
        createSubagentTool({
          subagents: this.subagents,
          parentSessionKey: params.sessionKey,
          parentAgentId: params.agentId,
        }),
      );
    }

    if (this.skillLoader && allowSet.has("skills_note")) {
      tools.push(
        createSkillsNoteTool({
          homeDir: params.homeDir,
          skillLoader: this.skillLoader,
        }),
      );
    }

    if (allowSet.has("exec")) {
      const allowlist = this.resolveExecAllowlist(params.entry);
      const allowedSecrets = this.resolveExecAllowedSecrets(params.entry);
      const executor = this.getSandboxExecutor({
        sandboxConfig: params.sandboxConfig,
        allowlist,
      });
      tools.push(
        createExecTool({
          executor,
          sessionKey: params.sessionKey,
          agentId: params.agentId,
          workspaceDir: params.workspaceDir,
          allowedSecrets,
          authResolver: this.config.runtime?.auth?.enabled
            ? createRuntimeSecretBroker({
                masterKeyEnv: this.config.runtime?.auth?.masterKeyEnv ?? "MOZI_MASTER_KEY",
              })
            : undefined,
        }),
      );
    }

    const codingTools = filterTools(createPiCodingTools(params.workspaceDir), allowList).tools;
    tools.push(...codingTools);

    if (allowSet.has("memory_search") || allowSet.has("memory_get")) {
      const manager = await getMemoryManager(this.config, params.agentId);
      const lifecycle = await getMemoryLifecycleOrchestrator(this.config, params.agentId);
      await lifecycle.handle({ type: "session_start", sessionKey: params.sessionKey });

      const lifecycleAwareManager = {
        ...manager,
        search: async (query: string, opts?: { maxResults?: number; minScore?: number }) => {
          await lifecycle.handle({ type: "search_requested", sessionKey: params.sessionKey });
          return manager.search(query, opts);
        },
      };

      const memoryTools = createMemoryTools({
        manager: lifecycleAwareManager,
        sessionKey: params.sessionKey,
      });
      const filtered = filterTools(memoryTools, allowList).tools;
      tools.push(...filtered);
    }

    if (this.toolProvider) {
      const provided = await this.toolProvider({
        sessionKey: params.sessionKey,
        agentId: params.agentId,
        workspaceDir: params.workspaceDir,
        homeDir: params.homeDir,
        sandboxConfig: params.sandboxConfig,
      });
      const filtered = filterTools(provided, allowList).tools;
      tools.push(...filtered);
    }

    // Inject tools from enabled extensions
    const extensionTools = this.extensionRegistry.collectTools();
    if (extensionTools.length > 0) {
      const filtered = filterTools(extensionTools, allowList).tools;
      tools.push(...filtered);
    }

    if (this.shouldSanitizeTools(params.modelSpec)) {
      return sanitizeTools(tools);
    }
    return tools;
  }

  private shouldSanitizeTools(modelSpec: ModelSpec): boolean {
    if (this.config.runtime?.sanitizeToolSchema === false) {
      return false;
    }
    if (modelSpec.api === "google-generative-ai") {
      return true;
    }
    return modelSpec.id.toLowerCase().includes("gemini");
  }

  getAgentFallbacks(agentId: string): string[] {
    const entry = this.getAgentEntry(agentId);
    const modelCfg = this.normalizeModelConfig(entry?.model);
    const defaults = this.normalizeModelConfig(this.config.agents?.defaults?.model);
    return modelCfg?.fallbacks ?? defaults?.fallbacks ?? [];
  }

  resolveLifecycleControlModel(params: {
    sessionKey: string;
    agentId?: string;
  }): {
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
    const entry = this.getAgentEntry(agentId);
    const modelCfg = this.normalizeModelConfig(entry?.model);
    const defaults = this.normalizeModelConfig(this.config.agents?.defaults?.model);
    switch (modality) {
      case "image":
        return modelCfg?.vision ?? defaults?.vision;
      case "audio":
        return modelCfg?.audio ?? defaults?.audio;
      case "video":
        return modelCfg?.video ?? defaults?.video;
      case "file":
        return modelCfg?.file ?? defaults?.file;
    }
  }

  private getAgentModalityFallbacks(
    agentId: string,
    modality: "image" | "audio" | "video" | "file",
  ): string[] {
    const entry = this.getAgentEntry(agentId);
    const modelCfg = this.normalizeModelConfig(entry?.model);
    const defaults = this.normalizeModelConfig(this.config.agents?.defaults?.model);
    switch (modality) {
      case "image":
        return modelCfg?.visionFallbacks ?? defaults?.visionFallbacks ?? [];
      case "audio":
        return modelCfg?.audioFallbacks ?? defaults?.audioFallbacks ?? [];
      case "video":
        return modelCfg?.videoFallbacks ?? defaults?.videoFallbacks ?? [];
      case "file":
        return modelCfg?.fileFallbacks ?? defaults?.fileFallbacks ?? [];
    }
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
      await this.setSessionModel(sessionKey, resolved.ref);
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
    const workspaceDir = this.resolveWorkspaceDir(resolvedId, entry);
    const homeDir = this.resolveHomeDir(resolvedId, entry);
    const session = this.sessions.getOrCreate(sessionKey, resolvedId);

    const lockedModel = session.currentModel;
    const modelRef = lockedModel || this.resolveAgentModelRef(resolvedId, entry);
    if (!modelRef) {
      throw new Error(`No model configured for agent ${resolvedId}`);
    }

    let agent = this.agents.get(sessionKey);
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

      const sandboxConfig = this.resolveSandboxConfig(resolvedId, entry);
      const model = this.buildPiModel(modelSpec);
      const tools = await this.buildTools({
        sessionKey,
        agentId: resolvedId,
        entry,
        workspaceDir,
        homeDir,
        sandboxConfig,
        modelSpec,
      });
      const toolNames = Array.from(new Set(tools.map((tool) => tool.name)));
      const systemPrompt = await this.buildSystemPrompt({
        homeDir,
        workspaceDir,
        basePrompt: entry?.systemPrompt,
        skills: entry?.skills,
        tools: toolNames,
        sandboxConfig,
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
      agent.agent.setSystemPrompt(systemPrompt);
      let persistedContext = Array.isArray(session.context)
        ? (session.context as AgentMessage[])
        : [];
      if (persistedContext.length > 0) {
        const historyLimit = this.resolveHistoryLimit(sessionKey);
        if (historyLimit && historyLimit > 0) {
          persistedContext = limitHistoryTurns(persistedContext, historyLimit);
        }
        const pruningConfig = this.resolveContextPruningConfig(entry);
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
        // Sanitize messages before loading into agent to prevent proxy-side metadata pollution
        const sanitizedMessages = sanitizePromptInputForModel(
          pruningResult.messages,
          modelRef,
          modelSpec.api,
        );
        agent.agent.replaceMessages(sanitizedMessages);
      }
      const thinkingLevel = this.resolveThinkingLevel(entry);
      if (thinkingLevel) {
        agent.setThinkingLevel(thinkingLevel);
      }
      this.agents.set(sessionKey, agent);
      this.agentModelRefs.set(sessionKey, modelRef);
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
    return checkBootstrapState(homeDir);
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
    if (this.skillLoader) {
      await this.skillLoader.loadAll();
      if (!this.skillsIndexSynced.has(params.homeDir)) {
        await this.skillLoader.syncHomeIndex(params.homeDir);
        this.skillsIndexSynced.add(params.homeDir);
      }
      skillsPrompt = this.skillLoader.formatForPrompt(params.skills);
    }

    const sections: string[] = [];

    const sandboxNote = this.buildSandboxPrompt({
      workspaceDir: params.workspaceDir,
      sandboxConfig: params.sandboxConfig,
    });
    const toolsNote = this.buildToolsSection(params.tools);
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
      sections.push(this.buildSkillsSection(skillsPrompt, params.tools));
    }

    return sections.join("\n\n");
  }

  async setSessionModel(sessionKey: string, modelRef: string): Promise<void> {
    this.sessions.update(sessionKey, { currentModel: modelRef });
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
      const oldNeedsSanitize = oldSpec ? this.shouldSanitizeTools(oldSpec) : false;
      const newNeedsSanitize = this.shouldSanitizeTools(spec);
      if (oldNeedsSanitize !== newNeedsSanitize) {
        agent.dispose();
        this.agents.delete(sessionKey);
        this.agentModelRefs.delete(sessionKey);
        return;
      }
    }

    await agent.setModel(this.buildPiModel(spec));
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
