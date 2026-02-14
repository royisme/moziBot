import type { ChannelPlugin } from "../../adapters/channels/plugin";
import type { AgentManager } from "../../agent-manager";
import type { ParsedCommand } from "./parser";
import {
  isReasoningLevel,
  isThinkingLevel,
  type ReasoningLevel,
  type ThinkingLevel,
} from "../../model/thinking";

export function parseInlineOverrides(
  parsedCommand: ParsedCommand | null,
): { thinkingLevel?: ThinkingLevel; reasoningLevel?: ReasoningLevel; promptText: string } | null {
  if (!parsedCommand || (parsedCommand.name !== "think" && parsedCommand.name !== "reasoning")) {
    return null;
  }
  const raw = parsedCommand.args.trim();
  const splitIndex = raw.indexOf(" -- ");
  if (splitIndex <= 0) {
    return null;
  }
  const level = raw.slice(0, splitIndex).trim().toLowerCase();
  const promptText = raw.slice(splitIndex + 4).trim();
  if (!promptText) {
    return null;
  }

  if (parsedCommand.name === "think" && isThinkingLevel(level)) {
    return { thinkingLevel: level, promptText };
  }
  if (parsedCommand.name === "reasoning" && isReasoningLevel(level)) {
    return { reasoningLevel: level, promptText };
  }
  return null;
}

export async function handleThinkCommand(params: {
  agentManager: AgentManager;
  sessionKey: string;
  agentId: string;
  channel: ChannelPlugin;
  peerId: string;
  args: string;
}): Promise<void> {
  const { agentManager, sessionKey, agentId, channel, peerId, args } = params;
  const raw = args.trim().toLowerCase();
  if (!raw) {
    const sessionLevel = (
      agentManager.getSessionMetadata(sessionKey) as { thinkingLevel?: ThinkingLevel } | undefined
    )?.thinkingLevel;
    const current = sessionLevel ?? agentManager.resolveConfiguredThinkingLevel(agentId) ?? "off";
    await channel.send(peerId, { text: `Current thinking level: ${current}` });
    return;
  }

  if (!isThinkingLevel(raw)) {
    await channel.send(peerId, {
      text: "Usage: /think off|minimal|low|medium|high|xhigh",
    });
    return;
  }

  agentManager.updateSessionMetadata(sessionKey, {
    thinkingLevel: raw,
  });
  const { agent } = await agentManager.getAgent(sessionKey, agentId);
  if (typeof (agent as { setThinkingLevel?: unknown }).setThinkingLevel === "function") {
    (agent as { setThinkingLevel: (level: ThinkingLevel) => void }).setThinkingLevel(raw);
  }
  await channel.send(peerId, { text: `Thinking level set to: ${raw}` });
}

export async function handleReasoningCommand(params: {
  agentManager: AgentManager;
  sessionKey: string;
  channel: ChannelPlugin;
  peerId: string;
  args: string;
}): Promise<void> {
  const { agentManager, sessionKey, channel, peerId, args } = params;
  const raw = args.trim().toLowerCase();
  if (!raw) {
    const sessionLevel = (
      agentManager.getSessionMetadata(sessionKey) as { reasoningLevel?: ReasoningLevel } | undefined
    )?.reasoningLevel;
    await channel.send(peerId, { text: `Current reasoning level: ${sessionLevel ?? "off"}` });
    return;
  }

  if (!isReasoningLevel(raw)) {
    await channel.send(peerId, { text: "Usage: /reasoning off|on|stream" });
    return;
  }

  agentManager.updateSessionMetadata(sessionKey, {
    reasoningLevel: raw,
  });
  await channel.send(peerId, { text: `Reasoning level set to: ${raw}` });
}
