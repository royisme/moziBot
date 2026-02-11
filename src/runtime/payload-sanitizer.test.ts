import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { describe, expect, it } from "vitest";
import {
  isGeminiLikeTarget,
  sanitizeMessagesForGemini,
  sanitizePromptInputForModel,
  validateMessageStructure,
} from "./payload-sanitizer";

describe("isGeminiLikeTarget", () => {
  it("returns true for gemini model IDs", () => {
    expect(isGeminiLikeTarget("gemini-2.5-pro")).toBe(true);
    expect(isGeminiLikeTarget("google/gemini-3-flash")).toBe(true);
    expect(isGeminiLikeTarget("quotio/gemini-3-flash-preview")).toBe(true);
  });

  it("returns false for non-Gemini models", () => {
    expect(isGeminiLikeTarget("any-model", "google-generative-ai")).toBe(false);
    expect(isGeminiLikeTarget("gpt-4o", "openai-responses")).toBe(false);
    expect(isGeminiLikeTarget("claude-sonnet-4", "anthropic-messages")).toBe(false);
    expect(isGeminiLikeTarget("quotio/local/minimax-m2.1")).toBe(false);
    expect(isGeminiLikeTarget("custom-model")).toBe(false);
  });
});

describe("sanitizeMessagesForGemini", () => {
  it("returns empty array unchanged", () => {
    const result = sanitizeMessagesForGemini([]);
    expect(result.messages).toEqual([]);
    expect(result.modified).toBe(false);
  });

  it("returns clean messages unchanged", () => {
    const messages: AgentMessage[] = [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi there" },
    ] as AgentMessage[];

    const result = sanitizeMessagesForGemini(messages);
    expect(result.messages).toHaveLength(2);
    expect(result.modified).toBe(false);
    expect(result.removedFields).toHaveLength(0);
  });

  it("removes request-level metadata from messages", () => {
    const messages = [
      {
        role: "user",
        content: "Hello",
        safetySettings: [{ category: "HARM_CATEGORY" }],
      },
      {
        role: "assistant",
        content: "Hi there",
        model: "gemini-3-flash-preview",
        requestId: "req-123",
        temperature: 0.4,
        topP: 0.95,
      },
      {
        role: "user",
        content: "Test",
        systemInstruction: "You are helpful",
        toolConfig: { functionCallingConfig: {} },
        userAgent: "test-agent",
      },
    ] as unknown as AgentMessage[];

    const result = sanitizeMessagesForGemini(messages);

    expect(result.modified).toBe(true);
    expect(result.removedFields).toHaveLength(3);

    // Verify fields were removed
    const sanitized0 = result.messages[0] as unknown as Record<string, unknown>;
    expect(sanitized0.safetySettings).toBeUndefined();
    expect(sanitized0.content).toBe("Hello");

    const sanitized1 = result.messages[1] as unknown as Record<string, unknown>;
    expect(sanitized1.model).toBeUndefined();
    expect(sanitized1.requestId).toBeUndefined();
    expect(sanitized1.temperature).toBeUndefined();
    expect(sanitized1.topP).toBeUndefined();
    expect(sanitized1.content).toBe("Hi there");

    const sanitized2 = result.messages[2] as unknown as Record<string, unknown>;
    expect(sanitized2.systemInstruction).toBeUndefined();
    expect(sanitized2.toolConfig).toBeUndefined();
    expect(sanitized2.userAgent).toBeUndefined();
  });

  it("preserves valid message fields", () => {
    const messages = [
      {
        role: "user",
        content: "Hello",
        metadata: { timestamp: 123456 },
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "Hi" }],
        toolCalls: [{ id: "call-1", name: "test" }],
      },
    ] as unknown as AgentMessage[];

    const result = sanitizeMessagesForGemini(messages);

    // metadata is not in our forbidden list, so it should be preserved
    const sanitized0 = result.messages[0] as unknown as Record<string, unknown>;
    expect(sanitized0.metadata).toBeDefined();
    expect(sanitized0.content).toBe("Hello");

    const sanitized1 = result.messages[1] as unknown as Record<string, unknown>;
    expect(sanitized1.content).toBeDefined();
    expect(sanitized1.toolCalls).toBeDefined();
  });

  it("handles messages with array content", () => {
    const messages = [
      {
        role: "user",
        content: [
          { type: "text", text: "Hello" },
          { type: "image", data: "base64..." },
        ],
        safetySettings: [],
      },
    ] as unknown as AgentMessage[];

    const result = sanitizeMessagesForGemini(messages);

    const sanitized = result.messages[0] as unknown as Record<string, unknown>;
    expect(sanitized.safetySettings).toBeUndefined();
    expect(Array.isArray(sanitized.content)).toBe(true);
    expect(sanitized.content as unknown[]).toHaveLength(2);
  });

  it("returns new array without mutating original", () => {
    const messages = [
      {
        role: "user",
        content: "Hello",
        safetySettings: [],
      },
    ] as unknown as AgentMessage[];

    const result = sanitizeMessagesForGemini(messages);

    expect(result.messages).not.toBe(messages);
    expect((messages[0] as unknown as Record<string, unknown>).safetySettings).toBeDefined();
  });
});

describe("sanitizePromptInputForModel", () => {
  it("sanitizes for Gemini-like targets", () => {
    const messages = [
      { role: "user", content: "Hello", safetySettings: [] },
    ] as unknown as AgentMessage[];

    const result = sanitizePromptInputForModel(messages, "gemini-3-flash", "google-generative-ai");

    const sanitized = result[0] as unknown as Record<string, unknown>;
    expect(sanitized.safetySettings).toBeUndefined();
  });

  it("does not modify messages for non-Gemini targets", () => {
    const messages = [
      { role: "user", content: "Hello", safetySettings: [] },
    ] as unknown as AgentMessage[];

    const result = sanitizePromptInputForModel(messages, "gpt-4o", "openai-responses");

    // Should return the same array (not just equal, but same reference)
    expect(result).toBe(messages);
  });

  it("prepends bootstrap user turn when history starts with assistant", () => {
    const messages = [
      {
        role: "assistant",
        content: [{ type: "text", text: "I started first" }],
      },
      {
        role: "user",
        content: "hello",
      },
    ] as unknown as AgentMessage[];

    const result = sanitizePromptInputForModel(
      messages,
      "gemini-3-flash",
      "openai-responses",
      "quotio",
    );
    const first = result[0] as unknown as { role?: unknown; content?: unknown };
    expect(first.role).toBe("user");
    expect(first.content).toBe("(session bootstrap)");
  });

  it("drops incomplete tool calls and repairs missing tool results", () => {
    const messages = [
      {
        role: "assistant",
        stopReason: "toolUse",
        content: [
          { type: "toolUse", id: "call-missing-args", name: "broken_tool" },
          {
            type: "toolUse",
            id: "call-ok",
            name: "ok_tool",
            arguments: { q: "x" },
          },
        ],
      },
      {
        role: "user",
        content: "follow-up",
      },
    ] as unknown as AgentMessage[];

    const result = sanitizePromptInputForModel(
      messages,
      "gemini-3-flash",
      "openai-responses",
      "quotio",
    );
    const hasBrokenToolCall = result.some((msg) => {
      if (!msg || typeof msg !== "object" || msg.role !== "assistant" || !Array.isArray(msg.content)) {
        return false;
      }
      return msg.content.some(
        (block) =>
          Boolean(block) &&
          typeof block === "object" &&
          (block as { type?: unknown }).type === "toolUse" &&
          (block as { id?: unknown }).id === "call-missing-args",
      );
    });
    expect(hasBrokenToolCall).toBe(false);

    const synthetic = result.find(
      (msg) =>
        Boolean(msg) &&
        typeof msg === "object" &&
        msg.role === "toolResult" &&
        (msg as { toolCallId?: unknown }).toolCallId === "call-ok",
    ) as unknown as { isError?: unknown; content?: unknown } | undefined;
    expect(Boolean(synthetic)).toBe(true);
    expect(synthetic?.isError).toBe(true);
    expect(Array.isArray(synthetic?.content)).toBe(true);
  });

  it("drops invalid thinking signatures for gemini", () => {
    const messages = [
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "abc", signature: "msg_invalid_signature" },
          { type: "text", text: "hello" },
        ],
      },
    ] as unknown as AgentMessage[];

    const result = sanitizePromptInputForModel(
      messages,
      "gemini-3-flash",
      "openai-responses",
      "openrouter",
    );
    const assistant = result.find((msg) => msg.role === "assistant") as
      | (Extract<AgentMessage, { role: "assistant" }> & { content: unknown[] })
      | undefined;
    expect(Boolean(assistant)).toBe(true);
    const hasThinkingBlock = assistant?.content.some(
      (block) => Boolean(block) && typeof block === "object" && (block as { type?: unknown }).type === "thinking",
    );
    expect(hasThinkingBlock).toBe(false);
  });

  it("normalizes gemini tool call IDs and keeps tool results paired", () => {
    const messages = [
      {
        role: "assistant",
        stopReason: "toolUse",
        content: [
          {
            type: "toolUse",
            id: "call@bad:id",
            name: "fetch",
            arguments: { url: "https://example.com" },
          },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "call@bad:id",
        toolName: "fetch",
        content: [{ type: "text", text: "ok" }],
      },
    ] as unknown as AgentMessage[];

    const result = sanitizePromptInputForModel(
      messages,
      "gemini-3-flash",
      "openai-responses",
      "quotio",
    );
    const assistant = result.find((msg) => msg.role === "assistant") as
      | Extract<AgentMessage, { role: "assistant" }>
      | undefined;
    expect(Boolean(assistant)).toBe(true);
    const toolBlock = (assistant?.content || []).find(
      (block) => Boolean(block) && typeof block === "object" && (block as { type?: unknown }).type === "toolUse",
    ) as { id?: unknown } | undefined;
    expect(typeof toolBlock?.id).toBe("string");
    expect(toolBlock?.id).toBe("callbadid");

    const toolResult = result.find((msg) => msg.role === "toolResult") as
      | ({ toolCallId?: unknown } & AgentMessage)
      | undefined;
    expect(toolResult?.toolCallId).toBe("callbadid");
  });

  it("normalizes tool call IDs to strict9 for mistral providers", () => {
    const messages = [
      {
        role: "assistant",
        stopReason: "toolUse",
        content: [
          {
            type: "toolCall",
            id: "mistral-call-very-long-id",
            name: "x",
            arguments: { a: 1 },
          },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "mistral-call-very-long-id",
        content: [{ type: "text", text: "ok" }],
      },
    ] as unknown as AgentMessage[];

    const result = sanitizePromptInputForModel(
      messages,
      "mistral-large",
      "openai-responses",
      "mistral",
    );
    const assistant = result.find((msg) => msg.role === "assistant") as
      | Extract<AgentMessage, { role: "assistant" }>
      | undefined;
    const block = assistant?.content.find(
      (content) =>
        Boolean(content) && typeof content === "object" && (content as { type?: unknown }).type === "toolCall",
    ) as { id?: unknown } | undefined;
    expect(typeof block?.id).toBe("string");
    const blockId = block?.id as string;
    expect(blockId.length).toBe(9);
    const toolResult = result.find((msg) => msg.role === "toolResult") as
      | ({ toolCallId?: unknown } & AgentMessage)
      | undefined;
    expect(typeof toolResult?.toolCallId).toBe("string");
    const toolResultId = toolResult?.toolCallId as string;
    expect(toolResultId.length).toBe(9);
  });

  it("merges consecutive user turns for anthropic", () => {
    const messages = [
      { role: "user", content: [{ type: "text", text: "first" }] },
      { role: "user", content: [{ type: "text", text: "second" }] },
      { role: "assistant", content: [{ type: "text", text: "ok" }] },
    ] as unknown as AgentMessage[];

    const result = sanitizePromptInputForModel(
      messages,
      "claude-sonnet-4",
      "anthropic-messages",
      "anthropic",
    );
    const userMessages = result.filter((msg) => msg.role === "user");
    expect(userMessages.length).toBe(1);
  });

  it("does not repair tool pairing for pure openai targets", () => {
    const messages = [
      {
        role: "assistant",
        stopReason: "toolUse",
        content: [{ type: "toolCall", id: "call-1", name: "x", arguments: { a: 1 } }],
      },
      { role: "user", content: "next" },
    ] as unknown as AgentMessage[];

    const result = sanitizePromptInputForModel(messages, "gpt-4.1", "openai-responses", "openai");
    const hasSyntheticToolResult = result.some(
      (msg) => Boolean(msg) && typeof msg === "object" && msg.role === "toolResult",
    );
    expect(hasSyntheticToolResult).toBe(false);
  });
});

describe("validateMessageStructure", () => {
  it("validates correct message structure", () => {
    const message = { role: "user", content: "Hello" } as unknown as AgentMessage;
    const result = validateMessageStructure(message);

    expect(result.valid).toBe(true);
    expect(result.issues).toHaveLength(0);
  });

  it("detects missing role", () => {
    const message = { content: "Hello" } as unknown as AgentMessage;
    const result = validateMessageStructure(message);

    expect(result.valid).toBe(false);
    expect(result.issues).toContain("Missing or invalid 'role' field");
  });

  it("detects unknown role", () => {
    const message = { role: "unknown", content: "Hello" } as unknown as AgentMessage;
    const result = validateMessageStructure(message);

    expect(result.valid).toBe(false);
    expect(result.issues).toContain("Unknown role: unknown");
  });

  it("detects request-level fields in message", () => {
    const message = {
      role: "user",
      content: "Hello",
      safetySettings: [],
      model: "test",
      topK: 40,
    } as unknown as AgentMessage;
    const result = validateMessageStructure(message);

    expect(result.valid).toBe(false);
    expect(result.issues).toContain("Request-level field 'safetySettings' found in message");
    expect(result.issues).toContain("Request-level field 'model' found in message");
    expect(result.issues).toContain("Request-level field 'topK' found in message");
  });

  it("handles non-object messages", () => {
    const result = validateMessageStructure("not an object" as unknown as AgentMessage);

    expect(result.valid).toBe(false);
    expect(result.issues).toContain("Message is not an object");
  });
});
