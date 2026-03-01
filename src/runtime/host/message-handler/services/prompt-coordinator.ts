import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { MoziConfig } from "../../../../config";
import {
  resolveMemoryBackendConfig,
  type ResolvedMemoryPersistenceConfig,
} from "../../../../memory/backend-config";
import type { FlushMetadata } from "../../../../memory/flush-manager";
import { recordTurnToTape, withForkTape } from "../../../../tape/integration.js";
import type { TapeService } from "../../../../tape/tape-service.js";
import type { TapeStore } from "../../../../tape/tape-store.js";
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
import type { StreamingCallback } from "./streaming";

interface PromptCoordinatorAgentManager {
  getAgent(
    sessionKey: string,
    agentId: string,
  ): Promise<{
    agent: PromptAgent & { messages: AgentMessage[] };
    modelRef: string;
    systemPrompt?: string;
  }>;
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
const DEBUG_LOG_PROMPT = process.env.MOZI_DEBUG_LOG_PROMPT === "1";

function findLatestAssistantMessage(messages: AgentMessage[]): AgentMessage | undefined {
  return [...messages]
    .toReversed()
    .find((m) => m && typeof m === "object" && (m as { role?: string }).role === "assistant");
}

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

/**
 * Extract tool calls and tool results from the agent messages for tape recording.
 * Looks for the most recent tool_call / tool_result messages following the last
 * user message (i.e., the current turn's tool activity).
 */
function extractTurnToolData(messages: AgentMessage[]): {
  toolCalls: Record<string, unknown>[];
  toolResults: unknown[];
} {
  // Walk messages in reverse to find the current turn's tool activity.
  // A "turn" starts at the last user message and ends at the latest assistant message.
  const toolCalls: Record<string, unknown>[] = [];
  const toolResults: unknown[] = [];

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i] as Record<string, unknown>;
    if (!msg || typeof msg !== "object") {
      continue;
    }

    const role = typeof msg.role === "string" ? msg.role : "";
    if (role === "user") {
      // Reached the user message boundary – stop scanning.
      break;
    }

    const content = msg.content;

    if (role === "tool") {
      // Tool result – collect raw content
      toolResults.unshift(typeof content === "string" ? content : content);
    } else if (role === "assistant" && Array.isArray(content)) {
      // Check for tool_call blocks inside assistant content array
      for (const block of content) {
        const b = block as Record<string, unknown>;
        if (b && (b.type === "tool_use" || b.type === "toolCall")) {
          toolCalls.push(b);
        }
      }
    } else if (role === "assistant" && content && typeof content === "object") {
      // Some models wrap tool calls in content directly
      const c = content as Record<string, unknown>;
      if (c.type === "tool_use" || c.type === "toolCall") {
        toolCalls.push(c);
      }
    }
  }

  return { toolCalls, toolResults };
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
  /**
   * Optional: returns a TapeService for dual-write recording.
   * When provided, each turn is recorded to the tape alongside the SessionStore transcript.
   */
  getTapeService?: (sessionKey: string) => TapeService | null | undefined;
  /**
   * Optional: returns the shared TapeStore for fork/merge isolation.
   * When provided alongside getTapeService, each prompt turn is wrapped in a tape fork
   * so that failed/aborted interactions do not pollute the main tape.
   */
  getTapeStore?: () => TapeStore | null | undefined;
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
    getTapeService,
    getTapeStore,
  } = params;

  if (DEBUG_LOG_PROMPT) {
    const current = await agentManager.getAgent(sessionKey, agentId);
    logger.debug(
      {
        sessionKey,
        agentId,
        traceId,
        modelRef: current.modelRef,
        systemPrompt: current.systemPrompt ?? "",
        userPromptText: text,
        messages: current.agent.messages,
      },
      "Prompt debug payload",
    );
  }

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
  const latestAssistant = findLatestAssistantMessage(current.agent.messages);

  logger.debug(
    {
      sessionKey,
      agentId,
      traceId,
      modelRef: current.modelRef,
      assistantMessageFound: Boolean(latestAssistant),
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

  // Tape write: record the turn to tape (sole persistence path for session history).
  // When getTapeStore is available, wrap the tape write in a fork so that failed/aborted
  // interactions do not pollute the main tape.
  if (getTapeService) {
    const tapeService = getTapeService(sessionKey);
    if (tapeService) {
      const tapeStore = getTapeStore ? getTapeStore() : null;

      const doRecord = (serviceToWrite: TapeService) => {
        const assistantText = latestAssistant
          ? extractAssistantText((latestAssistant as { content?: unknown }).content)
          : "";
        const { toolCalls, toolResults } = extractTurnToolData(current.agent.messages);
        recordTurnToTape(serviceToWrite, {
          userMessage: text,
          assistantMessage: assistantText,
          toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
          toolResults: toolResults.length > 0 ? toolResults : undefined,
          meta: { sessionKey, agentId, modelRef: current.modelRef, traceId },
        });
      };

      try {
        if (tapeStore) {
          // Fork/merge: entries written via forkedService are only committed to
          // the main tape on success; on failure they are discarded.
          await withForkTape(tapeService, tapeStore, async (forkedService) => {
            doRecord(forkedService);
          });
        } else {
          // No store available: fall back to direct write (no fork isolation).
          doRecord(tapeService);
        }
      } catch (tapeErr) {
        // Tape write failure must never break the main flow.
        logger.warn(
          { sessionKey, agentId, traceId, err: tapeErr },
          "Tape dual-write failed (non-fatal)",
        );
      }
    }
  }

  const usage = agentManager.getContextUsage(sessionKey);
  if (usage) {
    logger.debug(
      {
        traceId,
        sessionKey,
        agentId,
        responseTokens: latestAssistant ? estimateMessagesTokens([latestAssistant]) : 0,
        totalContextTokens: usage.usedTokens,
        contextWindow: usage.totalTokens,
        fillPercentage: usage.percentage,
      },
      "Prompt completed with usage stats",
    );
  }
}
