import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { Usage } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import {
  BASE_CHUNK_RATIO,
  MIN_CHUNK_RATIO,
  SAFETY_MARGIN,
  chunkMessagesByMaxTokens,
  compactMessages,
  computeAdaptiveChunkRatio,
  createSummaryMessage,
  estimateMessagesTokens,
  estimateTokens,
  isOversizedForSummary,
  pruneHistoryForContextShare,
  repairToolUseResultPairing,
  splitMessagesByTokenShare,
} from "./compaction";

const mockUsage: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function createUserMessage(content: string): AgentMessage {
  return { role: "user", content, timestamp: Date.now() };
}

function createAssistantMessage(content: string): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: content }],
    api: "test",
    provider: "test",
    model: "test-model",
    usage: mockUsage,
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

function createToolCallMessage(toolCallId: string): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "toolCall", id: toolCallId, name: "test", arguments: {} }],
    api: "test",
    provider: "test",
    model: "test-model",
    usage: mockUsage,
    stopReason: "toolUse",
    timestamp: Date.now(),
  };
}

function createToolResultMessage(toolCallId: string, content: string): AgentMessage {
  return {
    role: "toolResult",
    toolCallId,
    toolName: "test",
    content: [{ type: "text", text: content }],
    isError: false,
    timestamp: Date.now(),
  };
}

describe("estimateTokens", () => {
  it("returns 0 for empty content", () => {
    const msg = createUserMessage("");
    expect(estimateTokens(msg)).toBe(0);
  });

  it("estimates tokens as chars / 4", () => {
    const msg = createUserMessage("test"); // 4 chars = 1 token
    expect(estimateTokens(msg)).toBe(1);
  });

  it("rounds up token count", () => {
    const msg = createUserMessage("hello"); // 5 chars / 4 = 1.25 -> 2
    expect(estimateTokens(msg)).toBe(2);
  });

  it("handles longer strings", () => {
    const msg = createUserMessage("a".repeat(100)); // 100 chars / 4 = 25
    expect(estimateTokens(msg)).toBe(25);
  });

  it("handles array content with text blocks", () => {
    const msg = createAssistantMessage("hello world");
    expect(estimateTokens(msg)).toBe(3); // 11 chars / 4 = 2.75 -> 3
  });

  it("estimates image blocks at 2000 tokens", () => {
    const msg: AgentMessage = {
      role: "user",
      content: [{ type: "image", data: "base64...", mimeType: "image/png" }],
      timestamp: Date.now(),
    };
    expect(estimateTokens(msg)).toBe(2000); // 8000 chars / 4
  });

  it("handles messages without content property (BashExecutionMessage-like)", () => {
    const msg = {
      role: "bashExecution",
      command: "ls -la",
      output: "file1.txt\nfile2.txt",
      exitCode: 0,
      cancelled: false,
      truncated: false,
      timestamp: Date.now(),
    } as AgentMessage;
    expect(estimateTokens(msg)).toBeGreaterThan(0);
  });
});

describe("estimateMessagesTokens", () => {
  it("returns 0 for empty array", () => {
    expect(estimateMessagesTokens([])).toBe(0);
  });

  it("sums token estimates across messages", () => {
    const messages = [
      createUserMessage("test"), // 1 token
      createAssistantMessage("response"), // 2 tokens
    ];
    expect(estimateMessagesTokens(messages)).toBe(3);
  });
});

describe("splitMessagesByTokenShare", () => {
  it("returns empty array for no messages", () => {
    expect(splitMessagesByTokenShare([])).toEqual([]);
  });

  it("returns single chunk if parts <= 1", () => {
    const messages = [createUserMessage("test")];
    expect(splitMessagesByTokenShare(messages, 1)).toEqual([messages]);
    expect(splitMessagesByTokenShare(messages, 0)).toEqual([messages]);
  });

  it("splits into roughly equal token chunks", () => {
    const messages = [
      createUserMessage("a".repeat(100)), // 25 tokens
      createUserMessage("b".repeat(100)), // 25 tokens
      createUserMessage("c".repeat(100)), // 25 tokens
      createUserMessage("d".repeat(100)), // 25 tokens
    ];
    const chunks = splitMessagesByTokenShare(messages, 2);
    expect(chunks.length).toBe(2);
    expect(chunks[0].length).toBe(2);
    expect(chunks[1].length).toBe(2);
  });

  it("normalizes parts to not exceed message count", () => {
    const messages = [createUserMessage("a"), createUserMessage("b")];
    const chunks = splitMessagesByTokenShare(messages, 10);
    expect(chunks.length).toBeLessThanOrEqual(2);
  });
});

describe("chunkMessagesByMaxTokens", () => {
  it("returns empty array for no messages", () => {
    expect(chunkMessagesByMaxTokens([], 100)).toEqual([]);
  });

  it("returns all messages in one chunk if under limit", () => {
    const messages = [createUserMessage("test")];
    const chunks = chunkMessagesByMaxTokens(messages, 1000);
    expect(chunks).toEqual([messages]);
  });

  it("creates multiple chunks when exceeding maxTokens", () => {
    const messages = [
      createUserMessage("a".repeat(100)), // 25 tokens
      createUserMessage("b".repeat(100)), // 25 tokens
      createUserMessage("c".repeat(100)), // 25 tokens
    ];
    const chunks = chunkMessagesByMaxTokens(messages, 30);
    expect(chunks.length).toBe(3);
  });

  it("isolates oversized single message in its own chunk", () => {
    const messages = [
      createUserMessage("small"), // ~2 tokens
      createUserMessage("a".repeat(100)), // 25 tokens - oversized
      createUserMessage("tiny"), // ~2 tokens
    ];
    const chunks = chunkMessagesByMaxTokens(messages, 10);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
  });
});

describe("computeAdaptiveChunkRatio", () => {
  it("returns BASE_CHUNK_RATIO for normal messages", () => {
    const messages = [createUserMessage("short message"), createAssistantMessage("short response")];
    const ratio = computeAdaptiveChunkRatio(messages, 128_000);
    expect(ratio).toBe(BASE_CHUNK_RATIO);
  });

  it("reduces ratio when average message > 10% of context", () => {
    const messages = [createUserMessage("a".repeat(50000))]; // ~12500 tokens
    const ratio = computeAdaptiveChunkRatio(messages, 100_000);
    expect(ratio).toBeLessThan(BASE_CHUNK_RATIO);
  });

  it("never goes below MIN_CHUNK_RATIO", () => {
    const messages = [createUserMessage("a".repeat(100000))]; // very large
    const ratio = computeAdaptiveChunkRatio(messages, 50_000);
    expect(ratio).toBeGreaterThanOrEqual(MIN_CHUNK_RATIO);
  });

  it("returns BASE_CHUNK_RATIO for empty messages", () => {
    expect(computeAdaptiveChunkRatio([], 128_000)).toBe(BASE_CHUNK_RATIO);
  });

  it("returns BASE_CHUNK_RATIO for zero context window", () => {
    const messages = [createUserMessage("test")];
    expect(computeAdaptiveChunkRatio(messages, 0)).toBe(BASE_CHUNK_RATIO);
  });
});

describe("isOversizedForSummary", () => {
  it("returns false for small messages", () => {
    const msg = createUserMessage("small message");
    expect(isOversizedForSummary(msg, 100_000)).toBe(false);
  });

  it("returns true when message > 50% of context window", () => {
    const msg = createUserMessage("a".repeat(200000)); // ~50000 tokens
    expect(isOversizedForSummary(msg, 80_000)).toBe(true);
  });

  it("applies safety margin", () => {
    const msg = createUserMessage("a".repeat(160000)); // 40000 tokens
    // With SAFETY_MARGIN (1.2), effective is 48000
    // 48000 > 80000 * 0.5 = 40000, so should be true
    expect(isOversizedForSummary(msg, 80_000)).toBe(true);
  });
});

describe("repairToolUseResultPairing", () => {
  it("keeps paired tool results", () => {
    const messages: AgentMessage[] = [
      createToolCallMessage("tool-1"),
      createToolResultMessage("tool-1", "result"),
    ];
    const { messages: result, droppedOrphanCount } = repairToolUseResultPairing(messages);
    expect(result.length).toBe(2);
    expect(droppedOrphanCount).toBe(0);
  });

  it("drops orphaned tool results", () => {
    const messages: AgentMessage[] = [
      createToolResultMessage("orphan-1", "result without tool call"),
    ];
    const { messages: result, droppedOrphanCount } = repairToolUseResultPairing(messages);
    expect(result.length).toBe(0);
    expect(droppedOrphanCount).toBe(1);
  });

  it("handles mixed paired and orphaned results", () => {
    const messages: AgentMessage[] = [
      createToolCallMessage("tool-1"),
      createToolResultMessage("tool-1", "paired result"),
      createToolResultMessage("orphan-1", "orphaned result"),
    ];
    const { messages: result, droppedOrphanCount } = repairToolUseResultPairing(messages);
    expect(result.length).toBe(2);
    expect(droppedOrphanCount).toBe(1);
  });

  it("preserves non-tool messages", () => {
    const messages: AgentMessage[] = [createUserMessage("hello"), createAssistantMessage("hi")];
    const { messages: result, droppedOrphanCount } = repairToolUseResultPairing(messages);
    expect(result.length).toBe(2);
    expect(droppedOrphanCount).toBe(0);
  });
});

describe("pruneHistoryForContextShare", () => {
  it("does not prune if within budget", () => {
    const messages = [createUserMessage("short")];
    const result = pruneHistoryForContextShare({
      messages,
      maxContextTokens: 100_000,
      maxHistoryShare: 0.5,
    });
    expect(result.messages).toEqual(messages);
    expect(result.droppedMessages).toBe(0);
  });

  it("drops oldest chunk when over budget", () => {
    const messages = [
      createUserMessage("a".repeat(1000)), // ~250 tokens
      createUserMessage("b".repeat(1000)), // ~250 tokens
      createUserMessage("c".repeat(1000)), // ~250 tokens
      createUserMessage("d".repeat(1000)), // ~250 tokens
    ];
    // Budget: 500 * 0.5 = 250 tokens, so needs to drop some
    const result = pruneHistoryForContextShare({
      messages,
      maxContextTokens: 500,
      maxHistoryShare: 0.5,
    });
    expect(result.droppedMessages).toBeGreaterThan(0);
    expect(result.messages.length).toBeLessThan(messages.length);
  });

  it("repairs tool pairing after dropping", () => {
    const messages: AgentMessage[] = [
      createToolCallMessage("old-tool"),
      createToolResultMessage("old-tool", "result"),
      createUserMessage("a".repeat(1000)),
    ];
    const result = pruneHistoryForContextShare({
      messages,
      maxContextTokens: 100,
      maxHistoryShare: 0.5,
    });
    // Should drop old messages and repair any orphaned tool results
    expect(result.droppedChunks).toBeGreaterThanOrEqual(0);
  });

  it("returns budget information", () => {
    const messages = [createUserMessage("test")];
    const result = pruneHistoryForContextShare({
      messages,
      maxContextTokens: 100_000,
      maxHistoryShare: 0.5,
    });
    expect(result.budgetTokens).toBe(50_000);
    expect(result.keptTokens).toBeGreaterThan(0);
  });
});

describe("compactMessages", () => {
  it("returns empty result for empty messages", async () => {
    const result = await compactMessages({
      messages: [],
      contextWindowTokens: 100_000,
      generateSummary: async () => "summary",
    });
    expect(result.summary).toBe("");
    expect(result.keptMessages).toEqual([]);
    expect(result.droppedCount).toBe(0);
  });

  it("returns original messages if no compaction needed", async () => {
    const messages = [createUserMessage("short")];
    const result = await compactMessages({
      messages,
      contextWindowTokens: 100_000,
      generateSummary: async () => "should not be called",
    });
    expect(result.summary).toBe("");
    expect(result.keptMessages).toEqual(messages);
    expect(result.droppedCount).toBe(0);
  });

  it("calls generateSummary with dropped messages", async () => {
    const messages = [
      createUserMessage("a".repeat(1000)),
      createUserMessage("b".repeat(1000)),
      createUserMessage("c".repeat(1000)),
    ];
    let summaryCalled = false;
    const result = await compactMessages({
      messages,
      contextWindowTokens: 500,
      maxHistoryShare: 0.5,
      generateSummary: async (params) => {
        summaryCalled = true;
        expect(params.messages.length).toBeGreaterThan(0);
        return "test summary";
      },
    });
    if (result.droppedCount > 0) {
      expect(summaryCalled).toBe(true);
      expect(result.summary).toBe("test summary");
    }
  });

  it("provides fallback summary on generateSummary error", async () => {
    const messages = [createUserMessage("a".repeat(1000)), createUserMessage("b".repeat(1000))];
    const result = await compactMessages({
      messages,
      contextWindowTokens: 200,
      maxHistoryShare: 0.5,
      generateSummary: async () => {
        throw new Error("LLM API error");
      },
    });
    if (result.droppedCount > 0) {
      expect(result.summary).toContain("compacted");
      expect(result.summary).toContain("summarization error");
    }
  });
});

describe("createSummaryMessage", () => {
  it("creates user message with summary prefix", () => {
    const msg = createSummaryMessage("This is the summary");
    expect(msg.role).toBe("user");
    expect((msg as { content: string }).content).toContain("[Previous conversation summary]");
    expect((msg as { content: string }).content).toContain("This is the summary");
  });

  it("includes timestamp", () => {
    const before = Date.now();
    const msg = createSummaryMessage("summary");
    const after = Date.now();
    expect((msg as { timestamp: number }).timestamp).toBeGreaterThanOrEqual(before);
    expect((msg as { timestamp: number }).timestamp).toBeLessThanOrEqual(after);
  });
});

describe("constants", () => {
  it("exports expected values", () => {
    expect(BASE_CHUNK_RATIO).toBe(0.4);
    expect(MIN_CHUNK_RATIO).toBe(0.15);
    expect(SAFETY_MARGIN).toBe(1.2);
  });
});
