/**
 * Compaction utilities for managing context window overflow.
 *
 * Provides token estimation, message chunking, history pruning,
 * and LLM-based summarization to compact conversation history.
 */

import type { AgentMessage } from "@mariozechner/pi-agent-core";

/** Default ratio of context window to use for a single chunk */
export const BASE_CHUNK_RATIO = 0.4;

/** Minimum chunk ratio to prevent chunks from becoming too small */
export const MIN_CHUNK_RATIO = 0.15;

/** Safety margin multiplier for token estimation inaccuracy */
export const SAFETY_MARGIN = 1.2;

/** Default number of parts for splitting messages */
const DEFAULT_PARTS = 2;

/** Default max history share of context window */
const DEFAULT_MAX_HISTORY_SHARE = 0.5;

/** Characters per token approximation */
const CHARS_PER_TOKEN = 4;

/** Image block token estimate (8000 chars = 2000 tokens) */
const IMAGE_BLOCK_CHARS = 8000;

/**
 * Type guard to check if a message has a content property.
 * AgentMessage is a union type that includes custom messages like BashExecutionMessage
 * which may not have content.
 */
function hasContent(
  message: AgentMessage,
): message is AgentMessage & { content: string | unknown[] } {
  return "content" in message && message.content !== undefined;
}

/**
 * Estimate tokens for a single message.
 * Uses chars / 4 approximation. Handles string and array content.
 * Image blocks estimate at 8000 chars (2000 tokens).
 */
export function estimateTokens(message: AgentMessage): number {
  // Check if message has content property (not all AgentMessage types do)
  if (!hasContent(message)) {
    // For messages without content (e.g., BashExecutionMessage), estimate from other fields
    return Math.ceil(JSON.stringify(message).length / CHARS_PER_TOKEN);
  }

  const content = message.content;

  if (!content) {
    return 0;
  }

  let chars = 0;

  if (typeof content === "string") {
    chars = content.length;
  } else if (Array.isArray(content)) {
    for (const block of content) {
      if (typeof block === "string") {
        chars += block.length;
      } else if (block && typeof block === "object") {
        // Handle image blocks
        const blockType = (block as { type?: string }).type;
        if (blockType === "image" || blockType === "image_url") {
          chars += IMAGE_BLOCK_CHARS;
        } else {
          // For text blocks or other objects
          const text = (block as { text?: string }).text;
          if (text) {
            chars += text.length;
          } else {
            // Fallback: estimate based on JSON size
            chars += JSON.stringify(block).length / 2;
          }
        }
      }
    }
  } else {
    // Fallback for other content types
    chars = JSON.stringify(content).length;
  }

  return Math.ceil(chars / CHARS_PER_TOKEN);
}

/**
 * Estimate total tokens for an array of messages.
 */
export function estimateMessagesTokens(messages: AgentMessage[]): number {
  return messages.reduce((sum, message) => sum + estimateTokens(message), 0);
}

/**
 * Normalize parts count to valid range.
 */
function normalizeParts(parts: number, messageCount: number): number {
  if (!Number.isFinite(parts) || parts <= 1) {
    return 1;
  }
  return Math.min(Math.max(1, Math.floor(parts)), Math.max(1, messageCount));
}

/**
 * Split messages into N chunks based on token share.
 * Each chunk will have roughly equal token count.
 */
export function splitMessagesByTokenShare(
  messages: AgentMessage[],
  parts = DEFAULT_PARTS,
): AgentMessage[][] {
  if (messages.length === 0) {
    return [];
  }

  const normalizedParts = normalizeParts(parts, messages.length);
  if (normalizedParts <= 1) {
    return [messages];
  }

  const totalTokens = estimateMessagesTokens(messages);
  const targetTokens = totalTokens / normalizedParts;
  const chunks: AgentMessage[][] = [];
  let current: AgentMessage[] = [];
  let currentTokens = 0;

  for (const message of messages) {
    const messageTokens = estimateTokens(message);
    if (
      chunks.length < normalizedParts - 1 &&
      current.length > 0 &&
      currentTokens + messageTokens > targetTokens
    ) {
      chunks.push(current);
      current = [];
      currentTokens = 0;
    }

    current.push(message);
    currentTokens += messageTokens;
  }

  if (current.length > 0) {
    chunks.push(current);
  }

  return chunks;
}

/**
 * Chunk messages by maximum token limit per chunk.
 * Creates chunks that don't exceed maxTokens.
 */
export function chunkMessagesByMaxTokens(
  messages: AgentMessage[],
  maxTokens: number,
): AgentMessage[][] {
  if (messages.length === 0) {
    return [];
  }

  const chunks: AgentMessage[][] = [];
  let currentChunk: AgentMessage[] = [];
  let currentTokens = 0;

  for (const message of messages) {
    const messageTokens = estimateTokens(message);

    // If adding this message would exceed the limit, start a new chunk
    if (currentChunk.length > 0 && currentTokens + messageTokens > maxTokens) {
      chunks.push(currentChunk);
      currentChunk = [];
      currentTokens = 0;
    }

    currentChunk.push(message);
    currentTokens += messageTokens;

    // If this single message exceeds maxTokens, isolate it in its own chunk
    if (messageTokens > maxTokens) {
      chunks.push(currentChunk);
      currentChunk = [];
      currentTokens = 0;
    }
  }

  if (currentChunk.length > 0) {
    chunks.push(currentChunk);
  }

  return chunks;
}

/**
 * Compute adaptive chunk ratio based on average message size.
 * When messages are large, use smaller chunks to avoid exceeding model limits.
 */
export function computeAdaptiveChunkRatio(messages: AgentMessage[], contextWindow: number): number {
  if (messages.length === 0 || contextWindow <= 0) {
    return BASE_CHUNK_RATIO;
  }

  const totalTokens = estimateMessagesTokens(messages);
  const avgTokens = totalTokens / messages.length;

  // Apply safety margin to account for estimation inaccuracy
  const safeAvgTokens = avgTokens * SAFETY_MARGIN;
  const avgRatio = safeAvgTokens / contextWindow;

  // If average message is > 10% of context, reduce chunk ratio
  if (avgRatio > 0.1) {
    const reduction = Math.min(avgRatio * 2, BASE_CHUNK_RATIO - MIN_CHUNK_RATIO);
    return Math.max(MIN_CHUNK_RATIO, BASE_CHUNK_RATIO - reduction);
  }

  return BASE_CHUNK_RATIO;
}

/**
 * Check if a single message is too large to summarize.
 * If single message > 50% of context, it can't be summarized safely.
 */
export function isOversizedForSummary(msg: AgentMessage, contextWindow: number): boolean {
  const tokens = estimateTokens(msg) * SAFETY_MARGIN;
  return tokens > contextWindow * 0.5;
}

/**
 * Extract tool use IDs from assistant messages.
 */
function extractToolUseIds(messages: AgentMessage[]): Set<string> {
  const toolUseIds = new Set<string>();

  for (const msg of messages) {
    if (msg.role !== "assistant" || !hasContent(msg) || !Array.isArray(msg.content)) {
      continue;
    }

    for (const block of msg.content) {
      if (block && typeof block === "object") {
        const blockType = (block as { type?: string }).type;
        // ToolCall uses 'id', some older formats may use 'toolCallId'
        const toolId =
          (block as { id?: string }).id ?? (block as { toolCallId?: string }).toolCallId;
        if ((blockType === "toolCall" || blockType === "tool_use") && toolId) {
          toolUseIds.add(toolId);
        }
      }
    }
  }

  return toolUseIds;
}

/**
 * Repair tool use/result pairing by dropping orphaned tool results.
 * Returns repaired messages and count of dropped orphans.
 */
export function repairToolUseResultPairing(messages: AgentMessage[]): {
  messages: AgentMessage[];
  droppedOrphanCount: number;
} {
  const toolUseIds = extractToolUseIds(messages);
  let droppedOrphanCount = 0;

  const result = messages.filter((msg) => {
    if (msg.role === "toolResult") {
      const toolCallId = (msg as { toolCallId?: string }).toolCallId;
      if (toolCallId && !toolUseIds.has(toolCallId)) {
        droppedOrphanCount++;
        return false;
      }
    }
    return true;
  });

  return { messages: result, droppedOrphanCount };
}

/**
 * Prune history to fit within a budget share of the context window.
 * Iteratively drops oldest chunks until within budget.
 */
export function pruneHistoryForContextShare(params: {
  messages: AgentMessage[];
  maxContextTokens: number;
  maxHistoryShare?: number;
  parts?: number;
}): {
  messages: AgentMessage[];
  droppedMessagesList: AgentMessage[];
  droppedChunks: number;
  droppedMessages: number;
  droppedTokens: number;
  keptTokens: number;
  budgetTokens: number;
} {
  const maxHistoryShare = params.maxHistoryShare ?? DEFAULT_MAX_HISTORY_SHARE;
  const budgetTokens = Math.max(1, Math.floor(params.maxContextTokens * maxHistoryShare));
  let keptMessages = params.messages;
  const allDroppedMessages: AgentMessage[] = [];
  let droppedChunks = 0;
  let droppedMessages = 0;
  let droppedTokens = 0;

  const parts = normalizeParts(params.parts ?? DEFAULT_PARTS, keptMessages.length);

  while (keptMessages.length > 0 && estimateMessagesTokens(keptMessages) > budgetTokens) {
    const chunks = splitMessagesByTokenShare(keptMessages, parts);
    if (chunks.length <= 1) {
      break;
    }

    const [dropped, ...rest] = chunks;
    const flatRest = rest.flat();

    // Repair tool pairing after dropping
    const repairReport = repairToolUseResultPairing(flatRest);
    const repairedKept = repairReport.messages;
    const orphanedCount = repairReport.droppedOrphanCount;

    droppedChunks += 1;
    droppedMessages += dropped.length + orphanedCount;
    droppedTokens += estimateMessagesTokens(dropped);
    allDroppedMessages.push(...dropped);
    keptMessages = repairedKept;
  }

  return {
    messages: keptMessages,
    droppedMessagesList: allDroppedMessages,
    droppedChunks,
    droppedMessages,
    droppedTokens,
    keptTokens: estimateMessagesTokens(keptMessages),
    budgetTokens,
  };
}

/**
 * Parameters for generating a summary.
 */
export type SummaryParams = {
  messages: AgentMessage[];
  customInstructions?: string;
  previousSummary?: string;
};

/**
 * Result of compaction operation.
 */
export type CompactionResult = {
  summary: string;
  keptMessages: AgentMessage[];
  droppedCount: number;
  tokensReclaimed: number;
};

/**
 * Parameters for compacting messages.
 */
export type CompactMessagesParams = {
  messages: AgentMessage[];
  contextWindowTokens: number;
  maxHistoryShare?: number;
  generateSummary: (params: SummaryParams) => Promise<string>;
};

/**
 * Compact messages by pruning history and generating a summary.
 *
 * Algorithm:
 * 1. Calculate budget (maxHistoryShare * contextWindowTokens)
 * 2. Prune history if over budget
 * 3. Generate summary of dropped messages (with previous summary if available)
 * 4. Return summary + kept messages
 */
export async function compactMessages(params: CompactMessagesParams): Promise<CompactionResult> {
  const { messages, contextWindowTokens, maxHistoryShare, generateSummary } = params;

  if (messages.length === 0) {
    return {
      summary: "",
      keptMessages: [],
      droppedCount: 0,
      tokensReclaimed: 0,
    };
  }

  // Step 1: Prune history to fit budget
  const pruneResult = pruneHistoryForContextShare({
    messages,
    maxContextTokens: contextWindowTokens,
    maxHistoryShare,
  });

  // If nothing was dropped, no compaction needed
  if (pruneResult.droppedMessages === 0) {
    return {
      summary: "",
      keptMessages: messages,
      droppedCount: 0,
      tokensReclaimed: 0,
    };
  }

  // Step 2: Generate summary of dropped messages
  let summary: string;
  try {
    summary = await generateSummary({
      messages: pruneResult.droppedMessagesList,
      customInstructions:
        "Preserve: decisions made and their rationale, TODO items and open questions, key constraints and requirements, file paths and important code references, error patterns and solutions found.",
    });
  } catch {
    // Fallback to basic summary on error
    summary = `[Previous conversation with ${pruneResult.droppedMessages} messages was compacted. Details unavailable due to summarization error.]`;
  }

  return {
    summary,
    keptMessages: pruneResult.messages,
    droppedCount: pruneResult.droppedMessages,
    tokensReclaimed: pruneResult.droppedTokens,
  };
}

/**
 * Create a summary message from a summary text.
 */
export function createSummaryMessage(summary: string): AgentMessage {
  return {
    role: "user",
    content: `[Previous conversation summary]\n\n${summary}`,
    timestamp: Date.now(),
  };
}
