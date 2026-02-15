import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { logger } from "../../logger";

/**
 * Metadata fields that should NEVER appear inside message objects in the contents array.
 */
const REQUEST_LEVEL_METADATA_FIELDS = new Set([
  "safetySettings",
  "model",
  "systemInstruction",
  "toolConfig",
  "temperature",
  "topP",
  "topK",
  "stopSequences",
  "maxOutputTokens",
  "responseMimeType",
  "userAgent",
  "requestType",
  "requestId",
  "sessionId",
  "generationConfig",
  "thinkingConfig",
]);

/**
 * Valid message roles for Gemini and OpenAI APIs
 */
const VALID_MESSAGE_ROLES = new Set([
  "user",
  "assistant",
  "system",
  "developer",
  "tool",
  "toolResult",
  "function",
]);

interface SanitizeMessagesResult {
  messages: AgentMessage[];
  modified: boolean;
  removedFields: Array<{ messageIndex: number; fields: string[] }>;
}

const GOOGLE_TURN_ORDER_BOOTSTRAP_TEXT = "(session bootstrap)";
const GEMINI_SIGNATURE_RE = /^[A-Za-z0-9+/]+={0,2}$/;

export function isGeminiLikeTarget(modelRef: string, api?: string): boolean {
  void api;
  return modelRef.toLowerCase().includes("gemini");
}

export function validateGeminiTurns(messages: AgentMessage[]): AgentMessage[] {
  if (!Array.isArray(messages) || messages.length === 0) {
    return messages;
  }

  const result: AgentMessage[] = [];
  let lastRole: string | undefined;

  for (const msg of messages) {
    if (!msg || typeof msg !== "object") {
      result.push(msg);
      continue;
    }

    const msgRole = (msg as { role?: unknown }).role;
    if (typeof msgRole !== "string") {
      result.push(msg);
      continue;
    }

    if (msgRole === lastRole && lastRole === "assistant") {
      const lastMsg = result[result.length - 1];
      if (!lastMsg || typeof lastMsg !== "object") {
        result.push(msg);
        lastRole = msgRole;
        continue;
      }

      const currentAsst = msg as Extract<AgentMessage, { role: "assistant" }>;
      const previousAsst = lastMsg as Extract<AgentMessage, { role: "assistant" }>;
      const merged: Extract<AgentMessage, { role: "assistant" }> = {
        ...previousAsst,
        content: [
          ...(Array.isArray(previousAsst.content) ? previousAsst.content : []),
          ...(Array.isArray(currentAsst.content) ? currentAsst.content : []),
        ],
        ...(currentAsst.usage && { usage: currentAsst.usage }),
        ...(currentAsst.stopReason && { stopReason: currentAsst.stopReason }),
        ...(currentAsst.errorMessage && { errorMessage: currentAsst.errorMessage }),
      };
      result[result.length - 1] = merged;
      continue;
    }

    result.push(msg);
    lastRole = msgRole;
  }

  return result;
}

export function sanitizeGoogleTurnOrdering(messages: AgentMessage[]): AgentMessage[] {
  const first = messages[0] as { role?: unknown; content?: unknown } | undefined;
  if (
    first?.role === "user" &&
    typeof first.content === "string" &&
    first.content.trim() === GOOGLE_TURN_ORDER_BOOTSTRAP_TEXT
  ) {
    return messages;
  }
  if (first?.role !== "assistant") {
    return messages;
  }
  const bootstrap: AgentMessage = {
    role: "user",
    content: GOOGLE_TURN_ORDER_BOOTSTRAP_TEXT,
    timestamp: Date.now(),
  } as AgentMessage;
  return [bootstrap, ...messages];
}

export function isValidGeminiThinkingSignature(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return false;
  }
  if (trimmed.length % 4 !== 0) {
    return false;
  }
  return GEMINI_SIGNATURE_RE.test(trimmed);
}

export function sanitizeGeminiThinkingBlocks(messages: AgentMessage[]): AgentMessage[] {
  let touched = false;
  const out: AgentMessage[] = [];
  for (const msg of messages) {
    if (
      !msg ||
      typeof msg !== "object" ||
      msg.role !== "assistant" ||
      !Array.isArray(msg.content)
    ) {
      out.push(msg);
      continue;
    }
    type AssistantContentBlock = Extract<AgentMessage, { role: "assistant" }>["content"][number];
    const nextContent: AssistantContentBlock[] = [];
    let contentChanged = false;
    for (const block of msg.content) {
      if (
        !block ||
        typeof block !== "object" ||
        (block as { type?: unknown }).type !== "thinking"
      ) {
        nextContent.push(block);
        continue;
      }
      const rec = block as {
        thinkingSignature?: unknown;
        signature?: unknown;
        thought_signature?: unknown;
        thoughtSignature?: unknown;
      };
      const candidate =
        rec.thinkingSignature ?? rec.signature ?? rec.thought_signature ?? rec.thoughtSignature;
      if (!isValidGeminiThinkingSignature(candidate)) {
        contentChanged = true;
        continue;
      }
      if (rec.thinkingSignature !== candidate) {
        const nextBlock = {
          ...(block as unknown as Record<string, unknown>),
          thinkingSignature: candidate,
        } as AssistantContentBlock;
        nextContent.push(nextBlock);
        contentChanged = true;
      } else {
        nextContent.push(block);
      }
    }
    if (contentChanged) {
      touched = true;
    }
    if (nextContent.length === 0) {
      touched = true;
      continue;
    }
    out.push(contentChanged ? { ...msg, content: nextContent } : msg);
  }
  return touched ? out : messages;
}

/**
 * Deep clone and sanitize a single message object.
 * Removes any request-level metadata fields that may have leaked into the message.
 */
function sanitizeMessage(
  message: AgentMessage,
  _messageIndex: number,
): { message: AgentMessage; modified: boolean; removedFields: string[] } {
  if (!message || typeof message !== "object") {
    return { message, modified: false, removedFields: [] };
  }

  const removedFields: string[] = [];
  const messageKeys = Object.keys(message);

  for (const key of messageKeys) {
    if (REQUEST_LEVEL_METADATA_FIELDS.has(key)) {
      removedFields.push(key);
    }
  }

  if (removedFields.length === 0) {
    return { message, modified: false, removedFields: [] };
  }

  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(message as unknown as Record<string, unknown>)) {
    if (!REQUEST_LEVEL_METADATA_FIELDS.has(key)) {
      sanitized[key] = value;
    }
  }

  return { message: sanitized as unknown as AgentMessage, modified: true, removedFields };
}

/**
 * Sanitize an array of messages by removing request-level metadata fields
 * that may have leaked into individual message objects.
 */
export function sanitizeMessagesForGemini(messages: AgentMessage[]): SanitizeMessagesResult {
  if (!Array.isArray(messages) || messages.length === 0) {
    return { messages, modified: false, removedFields: [] };
  }

  const removedFields: Array<{ messageIndex: number; fields: string[] }> = [];
  let anyModified = false;

  const sanitizedMessages = messages.map((message, index) => {
    const result = sanitizeMessage(message, index);
    if (result.modified) {
      anyModified = true;
      removedFields.push({ messageIndex: index, fields: result.removedFields });
    }
    return result.message;
  });

  if (removedFields.length > 0) {
    logger.debug(
      {
        messageCount: messages.length,
        sanitizedCount: removedFields.length,
        removedFields: removedFields.map((r) => ({
          index: r.messageIndex,
          fields: r.fields,
        })),
      },
      "Sanitized messages: removed request-level metadata from contents[]",
    );
  }

  return {
    messages: sanitizedMessages,
    modified: anyModified,
    removedFields,
  };
}

/**
 * Optional: Validate that a message has a valid structure for LLM APIs.
 */
export function validateMessageStructure(message: AgentMessage): {
  valid: boolean;
  issues: string[];
} {
  const issues: string[] = [];

  if (!message || typeof message !== "object") {
    return { valid: false, issues: ["Message is not an object"] };
  }

  const msg = message as unknown as Record<string, unknown>;

  if (!msg.role || typeof msg.role !== "string") {
    issues.push("Missing or invalid 'role' field");
  } else if (!VALID_MESSAGE_ROLES.has(msg.role)) {
    issues.push(`Unknown role: ${msg.role}`);
  }

  for (const field of REQUEST_LEVEL_METADATA_FIELDS) {
    if (field in msg) {
      issues.push(`Request-level field '${field}' found in message`);
    }
  }

  return { valid: issues.length === 0, issues };
}
