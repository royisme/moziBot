import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { logger } from "../logger";

/**
 * Metadata fields that should NEVER appear inside message objects in the contents array.
 * These are request-level fields that belong at the root of the request, not inside individual messages.
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

/**
 * Check if a model reference or spec indicates a Gemini-like target that needs sanitization.
 * This includes:
 * - Direct Gemini API usage (google-generative-ai)
 * - Models with "gemini" in the ID
 * - Proxy endpoints that convert OpenAI to Gemini (like quotio)
 */
export function isGeminiLikeTarget(modelRef: string, api?: string): boolean {
  const lowerRef = modelRef.toLowerCase();

  // Direct Gemini API
  if (api === "google-generative-ai") {
    return true;
  }

  // Gemini model IDs
  if (lowerRef.includes("gemini")) {
    return true;
  }

  // Known proxy patterns that convert to Gemini
  // These are endpoints that may exhibit the contents[] metadata leak bug
  if (lowerRef.includes("quotio") || lowerRef.includes("cliproxy")) {
    return true;
  }

  return false;
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

  // Check for and collect metadata fields that shouldn't be here
  for (const key of messageKeys) {
    if (REQUEST_LEVEL_METADATA_FIELDS.has(key)) {
      removedFields.push(key);
    }
  }

  // If no forbidden fields found, return as-is
  if (removedFields.length === 0) {
    return { message, modified: false, removedFields: [] };
  }

  // Create a new message without the forbidden fields
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
 *
 * This is a defensive measure against proxy-side conversion bugs (e.g., Quotio/CLIProxyAPI)
 * that incorrectly include metadata in the contents[] array when converting OpenAI format to Gemini.
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
 * This can be used for debugging but should not be used to reject messages
 * as the underlying library may handle some edge cases.
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

  // Check for role
  if (!msg.role || typeof msg.role !== "string") {
    issues.push("Missing or invalid 'role' field");
  } else if (!VALID_MESSAGE_ROLES.has(msg.role)) {
    issues.push(`Unknown role: ${msg.role}`);
  }

  // Check for forbidden metadata fields
  for (const field of REQUEST_LEVEL_METADATA_FIELDS) {
    if (field in msg) {
      issues.push(`Request-level field '${field}' found in message`);
    }
  }

  return { valid: issues.length === 0, issues };
}

/**
 * Higher-level helper that conditionally sanitizes messages based on model type.
 * Use this at the callsite before sending messages to the agent/LLM.
 */
export function sanitizePromptInputForModel(
  messages: AgentMessage[],
  modelRef: string,
  api?: string,
): AgentMessage[] {
  // Only sanitize for Gemini-like targets
  if (!isGeminiLikeTarget(modelRef, api)) {
    return messages;
  }

  const result = sanitizeMessagesForGemini(messages);
  return result.messages;
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
