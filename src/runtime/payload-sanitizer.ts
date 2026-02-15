import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { logger } from "../logger";
import { resolveTranscriptPolicy } from "./transcript-policy";

// Re-export provider-specific modules for direct access
export {
  isGeminiLikeTarget,
  sanitizeMessagesForGemini,
  sanitizeGeminiThinkingBlocks,
  sanitizeGoogleTurnOrdering,
  validateGeminiTurns,
  isValidGeminiThinkingSignature,
  validateMessageStructure,
} from "./payload-sanitizer/gemini";

export { validateAnthropicTurns } from "./payload-sanitizer/anthropic";

export {
  repairToolUseResultPairing,
  repairToolCallInputs,
  extractToolCallsFromAssistant,
  normalizeToolCallId,
  sanitizeToolCallIdsForProvider,
} from "./payload-sanitizer/tool-repair";

import { validateAnthropicTurns } from "./payload-sanitizer/anthropic";
// Import for orchestration
import {
  isGeminiLikeTarget,
  sanitizeMessagesForGemini,
  sanitizeGeminiThinkingBlocks,
  sanitizeGoogleTurnOrdering,
  validateGeminiTurns,
} from "./payload-sanitizer/gemini";
import {
  repairToolCallInputs,
  repairToolUseResultPairing,
  sanitizeToolCallIdsForProvider,
} from "./payload-sanitizer/tool-repair";

/**
 * Higher-level helper that conditionally sanitizes messages based on model type.
 * Use this at the callsite before sending messages to the agent/LLM.
 */
export function sanitizePromptInputForModel(
  messages: AgentMessage[],
  modelRef: string,
  api?: string,
  provider?: string,
): AgentMessage[] {
  const policy = resolveTranscriptPolicy({ modelRef, api, provider });
  const shouldRunPipeline =
    isGeminiLikeTarget(modelRef, api) ||
    policy.sanitizeToolCallIds ||
    policy.repairToolUseResultPairing ||
    policy.validateAnthropicTurns;
  if (!shouldRunPipeline) {
    return messages;
  }

  const metadataSanitized = sanitizeMessagesForGemini(messages).messages;
  const toolIdsSanitized = policy.sanitizeToolCallIds
    ? sanitizeToolCallIdsForProvider(metadataSanitized, policy.toolCallIdMode ?? "strict")
    : { messages: metadataSanitized, renamedIds: 0 };
  if (policy.sanitizeToolCallIds && toolIdsSanitized.renamedIds > 0) {
    logger.debug(
      { renamedToolCallIds: toolIdsSanitized.renamedIds },
      "Sanitized provider-specific tool call IDs",
    );
  }
  const thinkingSanitized = policy.sanitizeThinkingSignatures
    ? sanitizeGeminiThinkingBlocks(toolIdsSanitized.messages)
    : toolIdsSanitized.messages;
  const repairedInputs = repairToolCallInputs(thinkingSanitized);
  if (repairedInputs.droppedToolCalls > 0 || repairedInputs.droppedAssistantMessages > 0) {
    logger.debug(
      {
        droppedToolCalls: repairedInputs.droppedToolCalls,
        droppedAssistantMessages: repairedInputs.droppedAssistantMessages,
      },
      "Sanitized Gemini tool-call inputs",
    );
  }
  const repairedPairing = policy.repairToolUseResultPairing
    ? repairToolUseResultPairing(repairedInputs.messages, policy.allowSyntheticToolResults)
    : {
        messages: repairedInputs.messages,
        addedCount: 0,
        droppedDuplicateCount: 0,
        droppedOrphanCount: 0,
        moved: false,
      };
  if (policy.repairToolUseResultPairing) {
    if (
      repairedPairing.addedCount > 0 ||
      repairedPairing.droppedDuplicateCount > 0 ||
      repairedPairing.droppedOrphanCount > 0 ||
      repairedPairing.moved
    ) {
      logger.debug(
        {
          addedToolResults: repairedPairing.addedCount,
          droppedDuplicateToolResults: repairedPairing.droppedDuplicateCount,
          droppedOrphanToolResults: repairedPairing.droppedOrphanCount,
          movedToolResults: repairedPairing.moved,
        },
        "Repaired tool-use/result pairing",
      );
    }
  }
  const ordered = policy.applyGoogleTurnOrdering
    ? sanitizeGoogleTurnOrdering(repairedPairing.messages)
    : repairedPairing.messages;
  const geminiValidated = policy.validateGeminiTurns ? validateGeminiTurns(ordered) : ordered;
  return policy.validateAnthropicTurns ? validateAnthropicTurns(geminiValidated) : geminiValidated;
}

/**
 * Log payload structure for debugging without exposing sensitive content.
 * Only logs field names and structure, not actual content values.
 */
export function logPayloadStructure(messages: AgentMessage[], context: string): void {
  const structure = messages.map((msg, idx) => {
    const keys = Object.keys(msg || {});
    const m = msg as unknown as Record<string, unknown>;
    let contentInfo: string;
    if (!m.content) {
      contentInfo = "no-content";
    } else if (typeof m.content === "string") {
      contentInfo = `string(${m.content.length} chars)`;
    } else if (Array.isArray(m.content)) {
      contentInfo = `array(${m.content.length} items)`;
    } else {
      contentInfo = typeof m.content;
    }
    return {
      index: idx,
      role: m?.role ?? "unknown",
      keys,
      content: contentInfo,
    };
  });

  logger.debug(
    {
      context,
      messageCount: messages.length,
      structure,
    },
    "Payload structure snapshot",
  );
}
