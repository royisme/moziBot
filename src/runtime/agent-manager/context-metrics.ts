import type { AgentSession } from "@mariozechner/pi-coding-agent";
import { logger } from "../../logger";
import { compactViaTape } from "../../tape/integration.js";
import type { TapeService } from "../../tape/tape-service.js";
import { estimateMessagesTokens, estimateTokens } from "../context-management";
import { getRuntimeHookRunner } from "../hooks";
import type { ModelRegistry } from "../model-registry";
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

export async function compactSession(params: {
  sessionKey: string;
  agents: Map<string, AgentSession>;
  sessions: SessionStore;
  getTapeService?: (sessionKey: string) => TapeService | null | undefined;
}): Promise<{ success: boolean; tokensReclaimed: number; reason?: string }> {
  const { sessionKey, agents, sessions, getTapeService } = params;
  const agent = agents.get(sessionKey);
  if (!agent) {
    return { success: false, tokensReclaimed: 0, reason: "No active agent session" };
  }

  const messages = agent.messages;
  if (messages.length < 4) {
    return { success: false, tokensReclaimed: 0, reason: "Too few messages to compact" };
  }

  const hookRunner = getRuntimeHookRunner();
  const sessionState = sessions.get(sessionKey);
  const agentId = sessionState?.agentId;
  const sessionFile = sessionState?.latestSessionFile;
  const messageCount = messages.length;
  const tokenCount = estimateMessagesTokens(messages);

  try {
    if (hookRunner.hasHooks("before_compaction")) {
      await hookRunner.runBeforeCompaction(
        {
          messageCount,
          compactingCount: messageCount,
          tokenCount,
          messages,
          sessionFile,
        },
        { sessionKey, agentId },
      );
    }

    const result = await agent.compact();

    // Tape dual-write: create an anchor recording the compaction summary.
    // This is additive — the existing destructive compaction is unchanged.
    // Tape errors are non-fatal.
    if (getTapeService) {
      try {
        const tapeService = getTapeService(sessionKey);
        if (tapeService) {
          const summary =
            typeof result === "object" && result !== null && "summary" in result
              ? ((result as { summary?: string }).summary ?? "")
              : "";
          compactViaTape(tapeService, summary);
        }
      } catch (tapeErr) {
        logger.warn(
          { sessionKey, err: tapeErr },
          "Tape compaction anchor write failed (non-fatal)",
        );
      }
    }

    if (hookRunner.hasHooks("after_compaction")) {
      const afterCount = agent.messages.length;
      await hookRunner.runAfterCompaction(
        {
          messageCount: afterCount,
          tokenCount: estimateMessagesTokens(agent.messages),
          compactedCount: Math.max(0, messageCount - afterCount),
          sessionFile,
        },
        { sessionKey, agentId },
      );
    }

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
