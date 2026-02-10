import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { Usage } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import {
  limitHistoryTurns,
  resolveHistoryLimitFromSessionKey,
  isDmSessionKey,
  extractDmPeerId,
} from "./history-limits";

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

describe("limitHistoryTurns", () => {
  it("returns all messages when limit is undefined", () => {
    const messages: AgentMessage[] = [
      createUserMessage("Hello"),
      createAssistantMessage("Hi there"),
      createUserMessage("How are you?"),
      createAssistantMessage("I am fine"),
    ];

    const result = limitHistoryTurns(messages, undefined);
    expect(result).toEqual(messages);
  });

  it("returns all messages when limit is 0", () => {
    const messages: AgentMessage[] = [
      createUserMessage("Hello"),
      createAssistantMessage("Hi there"),
    ];

    const result = limitHistoryTurns(messages, 0);
    expect(result).toEqual(messages);
  });

  it("returns all messages when limit is negative", () => {
    const messages: AgentMessage[] = [
      createUserMessage("Hello"),
      createAssistantMessage("Hi there"),
    ];

    const result = limitHistoryTurns(messages, -5);
    expect(result).toEqual(messages);
  });

  it("returns all messages when fewer turns than limit", () => {
    const messages: AgentMessage[] = [
      createUserMessage("Turn 1"),
      createAssistantMessage("Response 1"),
      createUserMessage("Turn 2"),
      createAssistantMessage("Response 2"),
    ];

    const result = limitHistoryTurns(messages, 5);
    expect(result).toEqual(messages);
  });

  it("returns last N user turns with their responses", () => {
    const messages: AgentMessage[] = [
      createUserMessage("Turn 1"), // Will be dropped
      createAssistantMessage("Response 1"), // Will be dropped
      createUserMessage("Turn 2"), // Will be dropped
      createAssistantMessage("Response 2"), // Will be dropped
      createUserMessage("Turn 3"), // Keep
      createAssistantMessage("Response 3"), // Keep
      createUserMessage("Turn 4"), // Keep
      createAssistantMessage("Response 4"), // Keep
    ];

    const result = limitHistoryTurns(messages, 2);
    expect(result).toHaveLength(4);
    expect((result[0] as { content: string }).content).toBe("Turn 3");
    expect(result[1]).toEqual(messages[5]);
    expect((result[2] as { content: string }).content).toBe("Turn 4");
    expect(result[3]).toEqual(messages[7]);
  });

  it("handles messages with no user messages (returns all)", () => {
    const messages: AgentMessage[] = [
      createAssistantMessage("System message 1"),
      createAssistantMessage("System message 2"),
    ];

    const result = limitHistoryTurns(messages, 1);
    expect(result).toEqual(messages);
  });

  it("handles empty message array", () => {
    const result = limitHistoryTurns([], 5);
    expect(result).toEqual([]);
  });

  it("handles single user turn correctly", () => {
    const messages: AgentMessage[] = [
      createUserMessage("Only turn"),
      createAssistantMessage("Response"),
    ];

    const result = limitHistoryTurns(messages, 1);
    expect(result).toEqual(messages);
  });

  it("preserves tool_use/tool_result pairs within turns", () => {
    const messages: AgentMessage[] = [
      createUserMessage("Turn 1"), // Will be dropped
      createToolCallMessage("call-1"), // Will be dropped
      createToolResultMessage("call-1", "Result 1"), // Will be dropped
      createAssistantMessage("Final 1"), // Will be dropped
      createUserMessage("Turn 2"), // Keep
      createToolCallMessage("call-2"), // Keep
      createToolResultMessage("call-2", "Result 2"), // Keep
      createAssistantMessage("Final 2"), // Keep
    ];

    const result = limitHistoryTurns(messages, 1);
    expect(result).toHaveLength(4);
    expect((result[0] as { content: string }).content).toBe("Turn 2");
    expect(result[1]).toEqual(messages[5]); // Tool call
    expect(result[2]).toEqual(messages[6]); // Tool result
    expect(result[3]).toEqual(messages[7]); // Final assistant
  });

  it("keeps exactly limit turns when more exist", () => {
    const messages: AgentMessage[] = [
      createUserMessage("Turn 1"),
      createAssistantMessage("Response 1"),
      createUserMessage("Turn 2"),
      createAssistantMessage("Response 2"),
      createUserMessage("Turn 3"),
      createAssistantMessage("Response 3"),
      createUserMessage("Turn 4"),
      createAssistantMessage("Response 4"),
      createUserMessage("Turn 5"),
      createAssistantMessage("Response 5"),
    ];

    const result = limitHistoryTurns(messages, 3);
    expect(result).toHaveLength(6);
    expect((result[0] as { content: string }).content).toBe("Turn 3");
  });

  it("handles user message at end without response", () => {
    const messages: AgentMessage[] = [
      createUserMessage("Turn 1"),
      createAssistantMessage("Response 1"),
      createUserMessage("Turn 2"),
      createAssistantMessage("Response 2"),
      createUserMessage("Turn 3"), // No response yet
    ];

    const result = limitHistoryTurns(messages, 2);
    expect(result).toHaveLength(3);
    expect((result[0] as { content: string }).content).toBe("Turn 2");
    expect((result[2] as { content: string }).content).toBe("Turn 3");
  });
});

describe("isDmSessionKey", () => {
  it("returns true for DM session keys", () => {
    expect(isDmSessionKey("agent:mozi:telegram:dm:user123")).toBe(true);
    expect(isDmSessionKey("agent:mozi:dm:user123")).toBe(true);
    expect(isDmSessionKey("agent:mozi:discord:default:dm:user123")).toBe(true);
  });

  it("returns false for group session keys", () => {
    expect(isDmSessionKey("agent:mozi:telegram:group:123")).toBe(false);
    expect(isDmSessionKey("agent:mozi:discord:channel:456")).toBe(false);
  });

  it("returns false for keys without dm segment", () => {
    expect(isDmSessionKey("agent:mozi:main")).toBe(false);
    expect(isDmSessionKey("")).toBe(false);
  });
});

describe("extractDmPeerId", () => {
  it("extracts peer ID from DM session key", () => {
    expect(extractDmPeerId("agent:mozi:telegram:dm:user123")).toBe("user123");
    expect(extractDmPeerId("agent:mozi:dm:user456")).toBe("user456");
  });

  it("handles peer ID with colons", () => {
    expect(extractDmPeerId("agent:mozi:telegram:dm:user:with:colons")).toBe("user:with:colons");
  });

  it("strips thread suffix from peer ID", () => {
    expect(extractDmPeerId("agent:mozi:telegram:dm:user123:thread:abc")).toBe("user123");
  });

  it("returns undefined for non-DM session keys", () => {
    expect(extractDmPeerId("agent:mozi:telegram:group:123")).toBeUndefined();
    expect(extractDmPeerId("agent:mozi:main")).toBeUndefined();
  });
});

describe("resolveHistoryLimitFromSessionKey", () => {
  it("returns undefined for group session keys", () => {
    const result = resolveHistoryLimitFromSessionKey("agent:mozi:telegram:group:123", {
      dmHistoryLimit: 10,
    });
    expect(result).toBeUndefined();
  });

  it("returns undefined when no config provided", () => {
    const result = resolveHistoryLimitFromSessionKey("agent:mozi:telegram:dm:user123");
    expect(result).toBeUndefined();
  });

  it("returns undefined for non-DM session keys", () => {
    const result = resolveHistoryLimitFromSessionKey("agent:mozi:main", {
      dmHistoryLimit: 10,
    });
    expect(result).toBeUndefined();
  });

  it("returns channel-level dmHistoryLimit", () => {
    const result = resolveHistoryLimitFromSessionKey("agent:mozi:telegram:dm:user123", {
      dmHistoryLimit: 20,
    });
    expect(result).toBe(20);
  });

  it("returns per-user override when configured", () => {
    const result = resolveHistoryLimitFromSessionKey("agent:mozi:telegram:dm:user123", {
      dmHistoryLimit: 20,
      dms: {
        user123: { historyLimit: 5 },
      },
    });
    expect(result).toBe(5);
  });

  it("per-user override takes precedence over channel default", () => {
    const result = resolveHistoryLimitFromSessionKey("agent:mozi:telegram:dm:special-user", {
      dmHistoryLimit: 100,
      dms: {
        "special-user": { historyLimit: 10 },
      },
    });
    expect(result).toBe(10);
  });

  it("returns channel default when user not in dms config", () => {
    const result = resolveHistoryLimitFromSessionKey("agent:mozi:telegram:dm:unknown-user", {
      dmHistoryLimit: 15,
      dms: {
        "other-user": { historyLimit: 5 },
      },
    });
    expect(result).toBe(15);
  });

  it("returns undefined when dms entry exists but has no historyLimit", () => {
    const result = resolveHistoryLimitFromSessionKey("agent:mozi:telegram:dm:user123", {
      dms: {
        user123: {},
      },
    });
    expect(result).toBeUndefined();
  });

  it("handles peer ID with colons", () => {
    const result = resolveHistoryLimitFromSessionKey("agent:mozi:telegram:dm:user:with:colons", {
      dmHistoryLimit: 25,
      dms: {
        "user:with:colons": { historyLimit: 3 },
      },
    });
    expect(result).toBe(3);
  });

  it("handles session key with thread suffix", () => {
    const result = resolveHistoryLimitFromSessionKey("agent:mozi:telegram:dm:user123:thread:abc", {
      dmHistoryLimit: 10,
      dms: {
        user123: { historyLimit: 5 },
      },
    });
    expect(result).toBe(5);
  });
});
