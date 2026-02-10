import type { Model } from "@mariozechner/pi-ai";
import { Agent } from "@mariozechner/pi-agent-core";
import type { ModelSpec } from "./types";
import { AgentManager } from "./agent-manager";
import { ModelRegistry } from "./model-registry";
import { ProviderRegistry } from "./provider-registry";

const MAX_CONCURRENT_SUBAGENTS = 2;

type SubagentRunParams = {
  parentSessionKey: string;
  parentAgentId: string;
  prompt: string;
  agentId?: string;
  model?: string;
};

export class SubagentRegistry {
  private activeCounts = new Map<string, number>();
  private tempCounters = new Map<string, number>();
  private tempAgents = new Map<string, Agent>();

  constructor(
    private modelRegistry: ModelRegistry,
    private providerRegistry: ProviderRegistry,
    private agentManager: AgentManager,
  ) {}

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

  private nextTempId(parentAgentId: string, sessionKey: string): string {
    const key = `${parentAgentId}:${sessionKey}`;
    const next = (this.tempCounters.get(key) || 0) + 1;
    this.tempCounters.set(key, next);
    return `${parentAgentId}-sub-${next}`;
  }

  private buildPiModel(spec: ModelSpec): Model<unknown> {
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
    } as unknown as Model<unknown>;
  }

  private ensureAllowed(params: { parentAgentId: string; targetAgentId: string }) {
    if (params.targetAgentId === "mozi") {
      throw new Error("Primary agent cannot be called as a subagent");
    }
    const parentEntry = this.agentManager.getAgentEntry(params.parentAgentId);
    const allow = parentEntry?.subagents?.allow ?? [];
    if (!allow.includes(params.targetAgentId)) {
      throw new Error(`Subagent not allowlisted: ${params.targetAgentId}`);
    }
  }

  async run(params: SubagentRunParams): Promise<string> {
    this.incActive(params.parentSessionKey);
    try {
      if (params.agentId) {
        this.ensureAllowed({
          parentAgentId: params.parentAgentId,
          targetAgentId: params.agentId,
        });
        const subSessionKey = `${params.agentId}::${params.parentSessionKey}`;
        const { agent } = await this.agentManager.getAgent(subSessionKey, params.agentId);
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
