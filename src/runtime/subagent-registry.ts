import { Agent } from "@mariozechner/pi-agent-core";
import type { Api, Model } from "@mariozechner/pi-ai";
import { AgentManager } from "./agent-manager";
import type { PromptMode } from "./agent-manager/prompt-builder";
import type { SessionManager } from "./host/sessions/manager";
import { spawnSubAgent } from "./host/sessions/spawn";
import type { DetachedRunRegistry as SessionDetachedRunRegistry } from "./host/sessions/spawn";
import { ModelRegistry } from "./model-registry";
import { ProviderRegistry } from "./provider-registry";
import type { ModelSpec } from "./types";

const MAX_CONCURRENT_SUBAGENTS = 2;
const DEFAULT_DETACHED_SUBAGENT_TIMEOUT_SECONDS = 300;

type SubagentRunParams = {
  parentSessionKey: string;
  parentAgentId: string;
  prompt: string;
  agentId?: string;
  model?: string;
  timeoutSeconds?: number;
  /** Visibility policy for the spawned task. Defaults to user_visible for user-originated work */
  visibilityPolicy?: "user_visible" | "internal_silent";
};

export interface SubagentSpawnResult {
  runId: string;
  childKey: string;
  sessionId: string;
  status: "accepted" | "rejected" | "error";
  error?: string;
}

export type HostSubagentRuntime = {
  sessionManager: SessionManager;
  detachedRunRegistry: SessionDetachedRunRegistry;
  startDetachedPromptRun: (params: {
    runId: string;
    sessionKey: string;
    agentId: string;
    text: string;
    traceId?: string;
    promptMode?: PromptMode;
    modelRef?: string;
    timeoutSeconds?: number;
    onAccepted?: () => Promise<void> | void;
    onTerminal?: (params: {
      terminal: "completed" | "failed" | "aborted" | "timeout";
      partialText?: string;
      error?: Error;
      reason?: string;
      errorCode?: string;
    }) => Promise<void> | void;
  }) => Promise<{ runId: string }>;
  isDetachedRunActive: (runId: string) => boolean;
};

export class SubagentRegistry {
  private activeCounts = new Map<string, number>();
  private activeDetachedRuns = new Map<string, string>();
  private tempCounters = new Map<string, number>();
  private tempAgents = new Map<string, Agent>();
  private readonly depthMap = new Map<string, number>();

  constructor(
    private modelRegistry: ModelRegistry,
    private providerRegistry: ProviderRegistry,
    private agentManager: AgentManager,
    private hostRuntime?: HostSubagentRuntime,
  ) {}

  reconfigure(params: {
    modelRegistry: ModelRegistry;
    providerRegistry: ProviderRegistry;
    agentManager: AgentManager;
    hostRuntime?: HostSubagentRuntime;
  }): void {
    this.modelRegistry = params.modelRegistry;
    this.providerRegistry = params.providerRegistry;
    this.agentManager = params.agentManager;
    this.hostRuntime = params.hostRuntime;
  }

  private incActive(sessionKey: string) {
    const current = this.activeCounts.get(sessionKey) || 0;
    if (current >= MAX_CONCURRENT_SUBAGENTS) {
      throw new Error("Subagent concurrency limit reached");
    }
    this.activeCounts.set(sessionKey, current + 1);
  }

  private decActive(sessionKey: string) {
    const current = this.activeCounts.get(sessionKey) || 0;
    this.activeCounts.set(sessionKey, Math.max(0, current - 1));
  }

  private getSpawnDepth(sessionKey: string): number {
    return this.depthMap.get(sessionKey) ?? 0;
  }

  private setSpawnDepth(sessionKey: string, depth: number): void {
    this.depthMap.set(sessionKey, depth);
  }

  private nextTempId(parentAgentId: string, sessionKey: string): string {
    const key = `${parentAgentId}:${sessionKey}`;
    const next = (this.tempCounters.get(key) || 0) + 1;
    this.tempCounters.set(key, next);
    return `${parentAgentId}-sub-${next}`;
  }

  private buildPiModel(spec: ModelSpec): Model<Api> {
    return {
      id: spec.id,
      name: spec.id,
      api: spec.api,
      provider: spec.provider,
      baseUrl: spec.baseUrl,
      reasoning: spec.reasoning ?? false,
      input: spec.input ?? ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: spec.contextWindow ?? 128000,
      maxTokens: spec.maxTokens ?? 8192,
      headers: spec.headers,
    } as unknown as Model<Api>;
  }

  private ensureAllowed(params: {
    parentAgentId: string;
    targetAgentId: string;
    sessionKey: string;
  }) {
    if (params.targetAgentId === "mozi") {
      throw new Error("Primary agent cannot be called as a subagent");
    }
    const depth = this.getSpawnDepth(params.sessionKey);
    const parentEntry = this.agentManager.getAgentEntry(params.parentAgentId);
    const maxDepth = parentEntry?.subagents?.maxDepth ?? 2;
    if (depth >= maxDepth) {
      throw new Error(`Max subagent spawn depth (${maxDepth}) reached`);
    }
    const allow = parentEntry?.subagents?.allow ?? [];
    if (!allow.includes(params.targetAgentId)) {
      throw new Error(`Subagent not allowlisted: ${params.targetAgentId}`);
    }
  }

  async spawn(params: SubagentRunParams): Promise<SubagentSpawnResult> {
    if (!this.hostRuntime) {
      throw new Error("Detached subagent runtime is not available");
    }

    this.incActive(params.parentSessionKey);
    const targetAgentId = params.agentId ?? params.parentAgentId;
    let runId: string | undefined;
    try {
      if (params.agentId) {
        this.ensureAllowed({
          parentAgentId: params.parentAgentId,
          targetAgentId,
          sessionKey: params.parentSessionKey,
        });
      }

      const spawnResult = await spawnSubAgent(
        this.hostRuntime.sessionManager,
        this.hostRuntime.detachedRunRegistry,
        {
          parentKey: params.parentSessionKey,
          agentId: targetAgentId,
          model: params.model,
          task: params.prompt,
          cleanup: "keep",
          timeoutSeconds: params.timeoutSeconds,
          visibilityPolicy: params.visibilityPolicy ?? "user_visible",
        },
      );
      runId = spawnResult.runId;

      if (spawnResult.status !== "accepted") {
        this.decActive(params.parentSessionKey);
        return spawnResult;
      }

      const detachedRunId = spawnResult.runId;
      const timeoutSeconds =
        this.hostRuntime.detachedRunRegistry.get(detachedRunId)?.timeoutSeconds ??
        params.timeoutSeconds ??
        DEFAULT_DETACHED_SUBAGENT_TIMEOUT_SECONDS;
      const parentDepth = this.getSpawnDepth(params.parentSessionKey);
      this.setSpawnDepth(spawnResult.childKey, parentDepth + 1);
      this.activeDetachedRuns.set(detachedRunId, params.parentSessionKey);

      const subagentPromptMode = this.agentManager.resolveSubagentPromptMode(params.parentAgentId);

      await this.hostRuntime.startDetachedPromptRun({
        runId: detachedRunId,
        sessionKey: spawnResult.childKey,
        agentId: targetAgentId,
        text: params.prompt,
        traceId: `subagent:${detachedRunId}`,
        promptMode: subagentPromptMode === "full" ? "main" : "subagent-minimal",
        modelRef: params.model,
        timeoutSeconds,
        onAccepted: async () => {
          this.hostRuntime?.detachedRunRegistry.markStarted(detachedRunId);
        },
        onTerminal: async ({ terminal, partialText, error, reason }) => {
          await this.hostRuntime?.detachedRunRegistry.completeByChildKey(spawnResult.childKey, {
            status: terminal,
            result: partialText,
            error: reason ?? error?.message,
          });
          const parentSessionKey = this.activeDetachedRuns.get(detachedRunId);
          if (parentSessionKey) {
            this.activeDetachedRuns.delete(detachedRunId);
            this.decActive(parentSessionKey);
          }
        },
      });

      return spawnResult;
    } catch (error) {
      if (typeof runId === "string") {
        this.activeDetachedRuns.delete(runId);
        await this.hostRuntime.detachedRunRegistry.setTerminal({
          runId,
          status: "failed",
          error: error instanceof Error ? error.message : String(error),
        });
      }
      this.decActive(params.parentSessionKey);
      throw error;
    }
  }

  async run(params: SubagentRunParams): Promise<string> {
    this.incActive(params.parentSessionKey);
    try {
      if (params.agentId) {
        this.ensureAllowed({
          parentAgentId: params.parentAgentId,
          targetAgentId: params.agentId,
          sessionKey: params.parentSessionKey,
        });
        const subSessionKey = `${params.agentId}::${params.parentSessionKey}`;
        const parentDepth = this.getSpawnDepth(params.parentSessionKey);
        this.depthMap.set(subSessionKey, parentDepth + 1);
        const subagentPromptMode = this.agentManager.resolveSubagentPromptMode(
          params.parentAgentId,
        );
        const { agent } = await this.agentManager.getAgent(subSessionKey, params.agentId, {
          promptMode: subagentPromptMode === "full" ? "main" : "subagent-minimal",
        });
        await agent.prompt(params.prompt);
        const last = [...agent.state.messages]
          .toReversed()
          .find((m: { role: string }) => m.role === "assistant");
        return this.extractText((last as { content?: unknown })?.content);
      }

      const tempId = this.nextTempId(params.parentAgentId, params.parentSessionKey);
      const modelRef =
        params.model ||
        (await this.resolveParentModel(params.parentSessionKey, params.parentAgentId));
      if (!modelRef) {
        throw new Error("No model available for temporary subagent");
      }
      const spec = this.modelRegistry.get(modelRef);
      if (!spec) {
        throw new Error(`Model not found: ${modelRef}`);
      }
      const key = `${tempId}::${params.parentSessionKey}`;
      let agent = this.tempAgents.get(key);
      if (!agent) {
        const parent = await this.agentManager.getAgent(
          params.parentSessionKey,
          params.parentAgentId,
        );
        agent = new Agent({
          initialState: {
            systemPrompt: parent.systemPrompt,
            model: this.buildPiModel(spec),
            tools: [],
            messages: [],
          },
          sessionId: key,
          getApiKey: (provider) => this.providerRegistry.resolveApiKey(provider),
        });
        this.tempAgents.set(key, agent);
      }
      await agent.prompt(params.prompt);
      const last = [...agent.state.messages]
        .toReversed()
        .find((m: { role: string }) => m.role === "assistant");
      return this.extractText((last as { content?: unknown })?.content);
    } finally {
      this.decActive(params.parentSessionKey);
    }
  }

  private async resolveParentModel(
    sessionKey: string,
    parentAgentId: string,
  ): Promise<string | undefined> {
    const resolved = await this.agentManager.getAgent(sessionKey, parentAgentId);
    return resolved.modelRef;
  }

  private extractText(content: unknown): string {
    if (!content) {
      return "";
    }
    if (typeof content === "string") {
      return content;
    }
    if (Array.isArray(content)) {
      return (content as Array<{ type?: string; text?: string }>)
        .filter((c) => c && c.type === "text" && typeof c.text === "string")
        .map((c) => c.text)
        .join("");
    }
    return "";
  }
}
