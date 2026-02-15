import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { AgentSession } from "@mariozechner/pi-coding-agent";
import { estimateMessagesTokens, estimateTokens } from "../context-management";
import type { ModelRegistry } from "../model-registry";
import { sanitizePromptInputForModel } from "../payload-sanitizer";
import type { SessionStore } from "../session-store";

export type ContextUsage = {
  usedTokens: number;
  totalTokens: number;
  percentage: number;
  messageCount: number;
};

export type ContextBreakdown = {
  systemPromptTokens: number;
  userMessageTokens: number;
  assistantMessageTokens: number;
  toolResultTokens: number;
  totalTokens: number;
};

export function updateSessionContext(params: {
  sessionKey: string;
  messages: unknown;
  sessions: SessionStore;
  modelRegistry: ModelRegistry;
  agentModelRefs: Map<string, string>;
}): void {
  const { sessionKey, messages, sessions, modelRegistry, agentModelRefs } = params;
  const session = sessions.get(sessionKey);
  const modelRef = agentModelRefs.get(sessionKey) || session?.currentModel;

  if (Array.isArray(messages) && modelRef) {
    const modelSpec = modelRegistry.get(modelRef);
    const sanitized = sanitizePromptInputForModel(
      messages as AgentMessage[],
      modelRef,
      modelSpec?.api,
      modelSpec?.provider,
    );
    sessions.update(sessionKey, { context: sanitized });
    return;
  }

  sessions.update(sessionKey, { context: messages });
}

export async function compactSession(params: {
  sessionKey: string;
  agents: Map<string, AgentSession>;
  sessions: SessionStore;
}): Promise<{ success: boolean; tokensReclaimed: number; reason?: string }> {
  const { sessionKey, agents, sessions } = params;
  const agent = agents.get(sessionKey);
  if (!agent) {
    return { success: false, tokensReclaimed: 0, reason: "No active agent session" };
  }

  const messages = agent.messages;
  if (messages.length < 4) {
    return { success: false, tokensReclaimed: 0, reason: "Too few messages to compact" };
  }

  try {
    const result = await agent.compact();
    sessions.update(sessionKey, { context: agent.messages });
    return {
      success: true,
      tokensReclaimed: result.tokensBefore,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, tokensReclaimed: 0, reason: msg };
  }
}

export function getContextUsage(params: {
  sessionKey: string;
  agents: Map<string, AgentSession>;
  agentModelRefs: Map<string, string>;
  modelRegistry: ModelRegistry;
}): ContextUsage | null {
  const { sessionKey, agents, agentModelRefs, modelRegistry } = params;
  const agent = agents.get(sessionKey);
  if (!agent) {
    return null;
  }

  const messages = agent.messages;
  const modelRef = agentModelRefs.get(sessionKey);
  const modelSpec = modelRef ? modelRegistry.get(modelRef) : undefined;
  const totalTokens = modelSpec?.contextWindow ?? 128_000;
  const usedTokens = estimateMessagesTokens(messages);

  return {
    usedTokens,
    totalTokens,
    percentage: Math.round((usedTokens / totalTokens) * 100),
    messageCount: messages.length,
  };
}

export function getContextBreakdown(params: {
  sessionKey: string;
  agents: Map<string, AgentSession>;
}): ContextBreakdown | null {
  const { sessionKey, agents } = params;
  const agent = agents.get(sessionKey);
  if (!agent) {
    return null;
  }

  const messages = agent.messages;
  let user = 0;
  let assistant = 0;
  let tool = 0;

  const system = Math.ceil((agent.systemPrompt || "").length / 4);
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
