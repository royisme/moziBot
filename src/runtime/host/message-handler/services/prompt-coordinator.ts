import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { MoziConfig } from "../../../../config";
import type { FlushMetadata } from "../../../../memory/flush-manager";
import type { StreamingCallback } from "./streaming";
import {
  resolveMemoryBackendConfig,
  type ResolvedMemoryPersistenceConfig,
} from "../../../../memory/backend-config";
import { estimateMessagesTokens } from "../../../context-management";
import { isCompactionFailureError, isContextOverflowError } from "../../../context-management";
import { isTransientError } from "../../../core/error-policy";
import { extractAssistantText, getAssistantFailureReason } from "../../reply-utils";
import {
  isAbortError as isAbortErrorService,
  isAgentBusyError as isAgentBusyErrorService,
  toError as toErrorService,
} from "./error-utils";
import {
  runPromptWithFallback as runPromptWithFallbackService,
  type PromptAgent,
} from "./prompt-runner";

interface PromptCoordinatorAgentManager {
  getAgent(
    sessionKey: string,
    agentId: string,
  ): Promise<{ agent: PromptAgent & { messages: AgentMessage[] }; modelRef: string }>;
  getAgentFallbacks(agentId: string): string[];
  setSessionModel(
    sessionKey: string,
    modelRef: string,
    options: { persist: boolean },
  ): Promise<void>;
  clearRuntimeModelOverride(sessionKey: string): void;
  resolvePromptTimeoutMs(agentId: string): number;
  getSessionMetadata(sessionKey: string): Record<string, unknown> | undefined;
  updateSessionMetadata(sessionKey: string, metadata: Record<string, unknown>): void;
  compactSession(
    sessionKey: string,
    agentId: string,
  ): Promise<{ success: boolean; tokensReclaimed?: number; reason?: string }>;
  updateSessionContext(sessionKey: string, messages: AgentMessage[]): void;
  getContextUsage(sessionKey: string): {
    usedTokens: number;
    totalTokens: number;
    percentage: number;
  } | null;
}

interface PromptCoordinatorLogger {
  warn(obj: Record<string, unknown>, msg: string): void;
  info(obj: Record<string, unknown>, msg: string): void;
  debug(obj: Record<string, unknown>, msg: string): void;
}

const LOG_PREVIEW_MAX_CHARS = 400;

function redactLogPreview(text: string): string {
  return text
    .replace(/bot\d+:[A-Za-z0-9_-]+/g, "bot<redacted>")
    .replace(/sk-[A-Za-z0-9_-]{16,}/g, "sk-<redacted>")
    .replace(/(Bearer\s+)[A-Za-z0-9._-]{16,}/gi, "$1<redacted>")
    .replace(/("(?:apiKey|token|authToken|botToken)"\s*:\s*")[^"]+(")/gi, "$1<redacted>$2");
}

function buildLogPreview(text: string, maxChars = LOG_PREVIEW_MAX_CHARS): string {
  if (!text) {
    return "";
  }
  const redacted = redactLogPreview(text);
  if (redacted.length <= maxChars) {
    return redacted;
  }
  return `${redacted.slice(0, maxChars)}... [truncated ${redacted.length - maxChars} chars]`;
}

export async function runPromptWithCoordinator(params: {
  sessionKey: string;
  agentId: string;
  text: string;
  traceId?: string;
  onStream?: StreamingCallback;
  onFallback?: (info: {
    fromModel: string;
    toModel: string;
    attempt: number;
    error: string;
  }) => Promise<void> | void;
  config: MoziConfig;
  logger: PromptCoordinatorLogger;
  agentManager: PromptCoordinatorAgentManager;
  activeMap: Map<
    string,
    { agentId: string; modelRef: string; startedAt: number; agent: PromptAgent }
  >;
  interruptedSet: Set<string>;
  flushMemory: (
    sessionKey: string,
    agentId: string,
    messages: AgentMessage[],
    config: ResolvedMemoryPersistenceConfig,
  ) => Promise<boolean>;
}): Promise<void> {
  const {
    sessionKey,
    agentId,
    text,
    traceId,
    onStream,
    onFallback,
    config,
    logger,
    agentManager,
    activeMap,
    interruptedSet,
    flushMemory,
  } = params;

  logger.debug(
    {
      sessionKey,
      agentId,
      traceId,
      promptChars: text.length,
      promptPreview: buildLogPreview(text),
    },
    "Prompt dispatch summary",
  );

  await runPromptWithFallbackService({
    sessionKey,
    agentId,
    text,
    traceId,
    onStream,
    onFallback,
    onContextOverflow: async (attempt) => {
      logger.warn(
        { traceId, sessionKey, agentId, attempt },
        "Context overflow detected, triggering auto-compaction",
      );

      const { agent } = await agentManager.getAgent(sessionKey, agentId);
      const memoryConfig = resolveMemoryBackendConfig({ cfg: config, agentId });
      if (memoryConfig.persistence.enabled && memoryConfig.persistence.onOverflowCompaction) {
        const meta = agentManager.getSessionMetadata(sessionKey)?.memoryFlush as
          | FlushMetadata
          | undefined;
        if (!meta || meta.lastAttemptedCycle < attempt) {
          const success = await flushMemory(
            sessionKey,
            agentId,
            agent.messages,
            memoryConfig.persistence,
          );
          agentManager.updateSessionMetadata(sessionKey, {
            memoryFlush: {
              lastAttemptedCycle: attempt,
              lastTimestamp: Date.now(),
              lastStatus: success ? "success" : "failure",
              trigger: "overflow",
            },
          });
        }
      }

      const compactResult = await agentManager.compactSession(sessionKey, agentId);
      if (!compactResult.success) {
        logger.warn(
          { traceId, sessionKey, reason: compactResult.reason },
          "Auto-compaction failed",
        );
        throw new Error("Auto-compaction failed");
      }
      logger.info(
        { traceId, sessionKey, tokensReclaimed: compactResult.tokensReclaimed },
        "Auto-compaction succeeded, retrying prompt",
      );
    },
    deps: {
      logger,
      agentManager: {
        getAgent: async (targetSessionKey, targetAgentId) => {
          const current = await agentManager.getAgent(targetSessionKey, targetAgentId);
          return { agent: current.agent, modelRef: current.modelRef };
        },
        getAgentFallbacks: (targetAgentId) => agentManager.getAgentFallbacks(targetAgentId),
        setSessionModel: async (targetSessionKey, modelRef, options) => {
          await agentManager.setSessionModel(targetSessionKey, modelRef, options);
        },
        clearRuntimeModelOverride: (targetSessionKey) =>
          agentManager.clearRuntimeModelOverride(targetSessionKey),
        resolvePromptTimeoutMs: (targetAgentId) =>
          agentManager.resolvePromptTimeoutMs(targetAgentId),
      },
      errorClassifiers: {
        isAgentBusyError: (err) => isAgentBusyErrorService(err),
        isContextOverflowError: (message) =>
          isContextOverflowError(message) && !isCompactionFailureError(message),
        isAbortError: (error) => isAbortErrorService(error),
        isTransientError: (message) => isTransientError(message),
        toError: (err) => toErrorService(err),
      },
    },
    activeMap,
    interruptedSet,
  });

  const current = await agentManager.getAgent(sessionKey, agentId);
  const latestAssistant = [...(current.agent.messages as Array<{ role?: string }>)]
    .toReversed()
    .find((m) => m && m.role === "assistant");
  const assistantRenderedText = latestAssistant ? extractAssistantText(latestAssistant) : "";
  const assistantStopReason =
    latestAssistant && typeof (latestAssistant as Record<string, unknown>).stopReason === "string"
      ? ((latestAssistant as Record<string, unknown>).stopReason as string)
      : undefined;

  logger.debug(
    {
      sessionKey,
      agentId,
      traceId,
      modelRef: current.modelRef,
      assistantMessageFound: Boolean(latestAssistant),
      assistantRenderedChars: assistantRenderedText.length,
      assistantRenderedPreview: buildLogPreview(assistantRenderedText),
      stopReason: assistantStopReason,
    },
    "Prompt result summary",
  );

  const failureReason = getAssistantFailureReason(latestAssistant);
  if (failureReason) {
    logger.warn(
      {
        traceId,
        sessionKey,
        agentId,
        modelRef: current.modelRef,
        failureReason,
        assistantMessageFound: Boolean(latestAssistant),
      },
      "Assistant message flagged as failed",
    );
    throw new Error(failureReason);
  }

  if (latestAssistant && assistantRenderedText.length === 0) {
    logger.warn(
      {
        traceId,
        sessionKey,
        agentId,
        modelRef: current.modelRef,
        stopReason: assistantStopReason,
      },
      "Assistant produced empty rendered output",
    );
  }

  agentManager.updateSessionContext(sessionKey, current.agent.messages);
  const usage = agentManager.getContextUsage(sessionKey);
  if (usage) {
    logger.debug(
      {
        traceId,
        sessionKey,
        agentId,
        responseTokens: latestAssistant
          ? estimateMessagesTokens([latestAssistant as AgentMessage])
          : 0,
        totalContextTokens: usage.usedTokens,
        contextWindow: usage.totalTokens,
        fillPercentage: usage.percentage,
      },
      "Prompt completed with usage stats",
    );
  }
}
