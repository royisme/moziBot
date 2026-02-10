import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { describe, expect, it } from "vitest";
import {
  isGeminiLikeTarget,
  sanitizeMessagesForGemini,
  sanitizePromptInputForModel,
  validateMessageStructure,
} from "./payload-sanitizer";

describe("isGeminiLikeTarget", () => {
  it("returns true for google-generative-ai API", () => {
    expect(isGeminiLikeTarget("any-model", "google-generative-ai")).toBe(true);
  });

  it("returns true for gemini model IDs", () => {
    expect(isGeminiLikeTarget("gemini-2.5-pro")).toBe(true);
    expect(isGeminiLikeTarget("google/gemini-3-flash")).toBe(true);
    expect(isGeminiLikeTarget("quotio/gemini-3-flash-preview")).toBe(true);
  });

  it("returns true for known proxy patterns", () => {
    expect(isGeminiLikeTarget("quotio/gemini-3-pro")).toBe(true);
    expect(isGeminiLikeTarget("cliproxy/gemini-2.5")).toBe(true);
  });

  it("returns false for non-Gemini models", () => {
    expect(isGeminiLikeTarget("gpt-4o", "openai-responses")).toBe(false);
    expect(isGeminiLikeTarget("claude-sonnet-4", "anthropic-messages")).toBe(false);
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
