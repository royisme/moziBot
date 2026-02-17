import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { MoziConfig } from "../../../../config";
import {
  resolveMemoryBackendConfig,
  type ResolvedMemoryPersistenceConfig,
} from "../../../../memory/backend-config";
import { getRuntimeHookRunner } from "../../../hooks";
import {
  normalizeIdentityLanguageHint,
  selectNewSessionFallbackText,
} from "./reset-greeting-language";

interface SendChannel {
  send(peerId: string, payload: { text: string }): Promise<unknown>;
}

interface AgentManagerLike {
  getAgent(
    sessionKey: string,
    agentId: string,
    options?: { promptMode?: "main" | "reset-greeting" | "subagent-minimal" },
  ): Promise<{ agent: { messages: AgentMessage[] } }>;
  updateSessionMetadata(sessionKey: string, metadata: Record<string, unknown>): void;
  resetSession(sessionKey: string, agentId: string): void;
  compactSession(
    sessionKey: string,
    agentId: string,
  ): Promise<{ success: boolean; tokensReclaimed?: number; reason?: string }>;
}

interface LoggerLike {
  warn?(obj: Record<string, unknown>, msg: string): void;
  info?(obj: Record<string, unknown>, msg: string): void;
}

interface ResetGreetingTurnResult {
  text?: string | null;
  identityLanguageHint?: string | null;
}

function normalizeResetGreetingResult(
  result: string | ResetGreetingTurnResult | null | undefined,
): {
  text: string | null;
  identityLanguageHint: string | null;
} {
  if (!result) {
    return { text: null, identityLanguageHint: null };
  }
  if (typeof result === "string") {
    return { text: result, identityLanguageHint: null };
  }
  return {
    text: typeof result.text === "string" ? result.text : null,
    identityLanguageHint: normalizeIdentityLanguageHint(result.identityLanguageHint),
  };
}

function buildGreetingPreview(text: string, maxChars = 80): string {
  const singleLine = text.replace(/\s+/g, " ").trim();
  if (singleLine.length <= maxChars) {
    return singleLine;
  }
  return `${singleLine.slice(0, maxChars - 3)}...`;
}

export async function handleNewSessionCommand(params: {
  sessionKey: string;
  agentId: string;
  channel: SendChannel;
  peerId: string;
  config: MoziConfig;
  agentManager: AgentManagerLike;
  flushMemory: (
    sessionKey: string,
    agentId: string,
    messages: AgentMessage[],
    config: ResolvedMemoryPersistenceConfig,
  ) => Promise<boolean>;
  runResetGreetingTurn?: (params: {
    sessionKey: string;
    agentId: string;
    peerId: string;
  }) => Promise<string | ResetGreetingTurnResult | null>;
  identityLanguageHint?: string | null;
  logger?: LoggerLike;
}): Promise<void> {
  const {
    sessionKey,
    agentId,
    channel,
    peerId,
    config,
    agentManager,
    flushMemory,
    runResetGreetingTurn,
    identityLanguageHint,
    logger,
  } = params;
  const commandStartAt = Date.now();
  let resolvedLanguageHint = normalizeIdentityLanguageHint(identityLanguageHint);
  const memoryConfig = resolveMemoryBackendConfig({ cfg: config, agentId });
  let snapshotMessages: AgentMessage[] | undefined;
  if (memoryConfig.persistence.enabled && memoryConfig.persistence.onNewReset) {
    const { agent } = await agentManager.getAgent(sessionKey, agentId);
    snapshotMessages = agent.messages;
    const success = await flushMemory(
      sessionKey,
      agentId,
      agent.messages,
      memoryConfig.persistence,
    );
    agentManager.updateSessionMetadata(sessionKey, {
      memoryFlush: {
        lastAttemptedCycle: 0,
        lastTimestamp: Date.now(),
        lastStatus: success ? "success" : "failure",
        trigger: "new",
      },
    });
  }

  const hookRunner = getRuntimeHookRunner();
  if (hookRunner.hasHooks("before_reset")) {
    if (!snapshotMessages) {
      const { agent } = await agentManager.getAgent(sessionKey, agentId);
      snapshotMessages = agent.messages;
    }
    await hookRunner.runBeforeReset(
      {
        reason: "new",
        messages: snapshotMessages ?? [],
      },
      {
        sessionKey,
        agentId,
      },
    );
  }

  agentManager.resetSession(sessionKey, agentId);

  let greetingSource: "reset-greeting" | "fallback" = "fallback";
  let fallbackReason:
    | "empty-reset-greeting"
    | "reset-greeting-error"
    | "reset-greeting-unavailable" = "reset-greeting-unavailable";
  let text = "";

  if (runResetGreetingTurn) {
    try {
      const result = normalizeResetGreetingResult(
        await runResetGreetingTurn({ sessionKey, agentId, peerId }),
      );
      resolvedLanguageHint = result.identityLanguageHint ?? resolvedLanguageHint;
      if (result.text && result.text.trim()) {
        text = result.text.trim();
        greetingSource = "reset-greeting";
      } else {
        fallbackReason = "empty-reset-greeting";
      }
    } catch (error) {
      fallbackReason = "reset-greeting-error";
      logger?.warn?.(
        {
          sessionKey,
          agentId,
          peerId,
          error,
        },
        "/new reset greeting failed, falling back to static text",
      );
    }
  }

  if (!text) {
    text = selectNewSessionFallbackText(resolvedLanguageHint);
  }

  await channel.send(peerId, { text });

  logger?.info?.(
    {
      sessionKey,
      agentId,
      peerId,
      greetingSource,
      identityLanguageHint: resolvedLanguageHint ?? null,
      greetingChars: text.length,
      durationMs: Date.now() - commandStartAt,
      fallbackReason: greetingSource === "fallback" ? fallbackReason : null,
      greetingPreview: buildGreetingPreview(text),
    },
    "/new greeting dispatched",
  );
}

export async function handleRestartCommand(params: {
  channel: SendChannel;
  peerId: string;
  runtimeControl?: { restart?: () => void | Promise<void> };
}): Promise<void> {
  const { channel, peerId, runtimeControl } = params;
  if (!runtimeControl?.restart) {
    await channel.send(peerId, {
      text: "Current runtime mode does not support /restart. Please run 'mozi runtime restart' on the host.",
    });
    return;
  }
  await channel.send(peerId, { text: "Restarting runtime..." });
  await runtimeControl.restart();
}

export async function handleCompactCommand(params: {
  sessionKey: string;
  agentId: string;
  channel: SendChannel;
  peerId: string;
  agentManager: AgentManagerLike;
}): Promise<void> {
  const { sessionKey, agentId, channel, peerId, agentManager } = params;
  await channel.send(peerId, { text: "Compacting session..." });

  const result = await agentManager.compactSession(sessionKey, agentId);
  if (result.success) {
    await channel.send(peerId, {
      text: `Session compacted, freed approximately ${result.tokensReclaimed} tokens.`,
    });
  } else {
    await channel.send(peerId, {
      text: `Compaction failed: ${result.reason || "Unknown error"}`,
    });
  }
}
