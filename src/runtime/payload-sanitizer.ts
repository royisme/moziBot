import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { logger } from "../logger";
import { resolveTranscriptPolicy, type ToolCallIdMode } from "./transcript-policy";

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

const GOOGLE_TURN_ORDER_BOOTSTRAP_TEXT = "(session bootstrap)";
const TOOL_CALL_TYPES = new Set(["toolCall", "toolUse", "functionCall"]);

type ToolCallLike = {
  id: string;
  name?: string;
};

type ToolCallBlock = {
  type?: unknown;
  id?: unknown;
  name?: unknown;
  input?: unknown;
  arguments?: unknown;
};

const GEMINI_SIGNATURE_RE = /^[A-Za-z0-9+/]+={0,2}$/;
const GEMINI_TOOL_ID_RE = /^[A-Za-z0-9_-]+$/;

export function isGeminiLikeTarget(modelRef: string, api?: string): boolean {
  void api;
  return modelRef.toLowerCase().includes("gemini");
}

function validateGeminiTurns(messages: AgentMessage[]): AgentMessage[] {
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

function validateAnthropicTurns(messages: AgentMessage[]): AgentMessage[] {
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

    if (msgRole === lastRole && lastRole === "user") {
      const lastMsg = result[result.length - 1];
      if (!lastMsg || typeof lastMsg !== "object") {
        result.push(msg);
        lastRole = msgRole;
        continue;
      }
      const previous = lastMsg as Extract<AgentMessage, { role: "user" }>;
      const current = msg as Extract<AgentMessage, { role: "user" }>;
      const merged: Extract<AgentMessage, { role: "user" }> = {
        ...current,
        content: [
          ...(Array.isArray(previous.content) ? previous.content : []),
          ...(Array.isArray(current.content) ? current.content : []),
        ],
        timestamp: current.timestamp ?? previous.timestamp,
      };
      result[result.length - 1] = merged;
      continue;
    }

    result.push(msg);
    lastRole = msgRole;
  }

  return result;
}

function sanitizeGoogleTurnOrdering(messages: AgentMessage[]): AgentMessage[] {
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

function extractToolCallsFromAssistant(
  msg: Extract<AgentMessage, { role: "assistant" }>,
): ToolCallLike[] {
  if (!Array.isArray(msg.content)) {
    return [];
  }
  const toolCalls: ToolCallLike[] = [];
  for (const block of msg.content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const rec = block as { type?: unknown; id?: unknown; name?: unknown };
    if (typeof rec.id !== "string" || !rec.id) {
      continue;
    }
    if (typeof rec.type === "string" && TOOL_CALL_TYPES.has(rec.type)) {
      toolCalls.push({
        id: rec.id,
        name: typeof rec.name === "string" ? rec.name : undefined,
      });
    }
  }
  return toolCalls;
}

function isToolCallBlock(block: unknown): block is ToolCallBlock {
  if (!block || typeof block !== "object") {
    return false;
  }
  const type = (block as { type?: unknown }).type;
  return typeof type === "string" && TOOL_CALL_TYPES.has(type);
}

function hasToolCallInput(block: ToolCallBlock): boolean {
  const hasInput = "input" in block ? block.input !== undefined && block.input !== null : false;
  const hasArguments =
    "arguments" in block ? block.arguments !== undefined && block.arguments !== null : false;
  return hasInput || hasArguments;
}

function extractToolResultId(msg: Extract<AgentMessage, { role: "toolResult" }>): string | null {
  const toolCallId = (msg as { toolCallId?: unknown }).toolCallId;
  if (typeof toolCallId === "string" && toolCallId) {
    return toolCallId;
  }
  const toolUseId = (msg as { toolUseId?: unknown }).toolUseId;
  if (typeof toolUseId === "string" && toolUseId) {
    return toolUseId;
  }
  return null;
}

function makeMissingToolResult(params: {
  toolCallId: string;
  toolName?: string;
}): Extract<AgentMessage, { role: "toolResult" }> {
  return {
    role: "toolResult",
    toolCallId: params.toolCallId,
    toolName: params.toolName ?? "unknown",
    content: [
      {
        type: "text",
        text: "[mozi] missing tool result in session history; inserted synthetic error result for transcript repair.",
      },
    ],
    isError: true,
    timestamp: Date.now(),
  } as Extract<AgentMessage, { role: "toolResult" }>;
}

function repairToolCallInputs(messages: AgentMessage[]): {
  messages: AgentMessage[];
  droppedToolCalls: number;
  droppedAssistantMessages: number;
} {
  let droppedToolCalls = 0;
  let droppedAssistantMessages = 0;
  let changed = false;
  const out: AgentMessage[] = [];

  for (const msg of messages) {
    if (!msg || typeof msg !== "object") {
      out.push(msg);
      continue;
    }
    if (msg.role !== "assistant" || !Array.isArray(msg.content)) {
      out.push(msg);
      continue;
    }

    const nextContent = [];
    let droppedInMessage = 0;
    for (const block of msg.content) {
      if (isToolCallBlock(block) && !hasToolCallInput(block)) {
        droppedToolCalls += 1;
        droppedInMessage += 1;
        changed = true;
        continue;
      }
      nextContent.push(block);
    }

    if (droppedInMessage > 0) {
      if (nextContent.length === 0) {
        droppedAssistantMessages += 1;
        changed = true;
        continue;
      }
      out.push({ ...msg, content: nextContent });
      continue;
    }

    out.push(msg);
  }

  return {
    messages: changed ? out : messages,
    droppedToolCalls,
    droppedAssistantMessages,
  };
}

function normalizeToolCallId(id: string, fallbackSeed: number, mode: ToolCallIdMode): string {
  const trimmed = id.trim();
  const strictId = trimmed.replaceAll(/[^A-Za-z0-9]/g, "");
  if (mode === "strict9") {
    const base = (strictId || `toolcall${fallbackSeed}`).slice(0, 9);
    if (base.length === 9) {
      return base;
    }
    return `${base}${"0".repeat(9 - base.length)}`;
  }
  if (!trimmed) {
    return `toolcall_${fallbackSeed}`;
  }
  if (GEMINI_TOOL_ID_RE.test(trimmed)) {
    return trimmed;
  }
  const sanitized = trimmed.replaceAll(/[^A-Za-z0-9_-]/g, "");
  if (sanitized) {
    return sanitized;
  }
  return `toolcall_${fallbackSeed}`;
}

function sanitizeToolCallIdsForProvider(
  messages: AgentMessage[],
  mode: ToolCallIdMode,
): {
  messages: AgentMessage[];
  renamedIds: number;
} {
  let changed = false;
  let renamedIds = 0;
  let seq = 0;
  const idMap = new Map<string, string>();
  const out: AgentMessage[] = [];

  for (const msg of messages) {
    if (!msg || typeof msg !== "object") {
      out.push(msg);
      continue;
    }

    if (msg.role === "assistant" && Array.isArray(msg.content)) {
      type AssistantContentBlock = Extract<AgentMessage, { role: "assistant" }>["content"][number];
      const nextContent: AssistantContentBlock[] = [];
      let contentChanged = false;
      for (const block of msg.content) {
        if (!block || typeof block !== "object") {
          nextContent.push(block);
          continue;
        }
        const rec = block as { type?: unknown; id?: unknown };
        if (typeof rec.type !== "string" || !TOOL_CALL_TYPES.has(rec.type) || typeof rec.id !== "string") {
          nextContent.push(block);
          continue;
        }
        const normalized = normalizeToolCallId(rec.id, seq++, mode);
        if (normalized !== rec.id) {
          idMap.set(rec.id, normalized);
          renamedIds += 1;
          contentChanged = true;
          nextContent.push({
            ...(block as unknown as Record<string, unknown>),
            id: normalized,
          } as AssistantContentBlock);
          continue;
        }
        nextContent.push(block);
      }
      if (contentChanged) {
        changed = true;
        out.push({ ...msg, content: nextContent });
      } else {
        out.push(msg);
      }
      continue;
    }

    if (msg.role === "toolResult") {
      const rec = msg as unknown as Record<string, unknown>;
      let msgChanged = false;
      const next: Record<string, unknown> = { ...rec };
      const keys: Array<"toolCallId" | "toolUseId"> = ["toolCallId", "toolUseId"];
      for (const key of keys) {
        const value = rec[key];
        if (typeof value !== "string") {
          continue;
        }
        const mapped = idMap.get(value) ?? normalizeToolCallId(value, seq++, mode);
        if (mapped !== value) {
          renamedIds += idMap.has(value) ? 0 : 1;
          next[key] = mapped;
          msgChanged = true;
        }
      }
      if (msgChanged) {
        changed = true;
        out.push(next as unknown as AgentMessage);
      } else {
        out.push(msg);
      }
      continue;
    }

    out.push(msg);
  }

  return {
    messages: changed ? out : messages,
    renamedIds,
  };
}

function isValidGeminiThinkingSignature(value: unknown): value is string {
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

function sanitizeGeminiThinkingBlocks(messages: AgentMessage[]): AgentMessage[] {
  let touched = false;
  const out: AgentMessage[] = [];
  for (const msg of messages) {
    if (!msg || typeof msg !== "object" || msg.role !== "assistant" || !Array.isArray(msg.content)) {
      out.push(msg);
      continue;
    }
    type AssistantContentBlock = Extract<AgentMessage, { role: "assistant" }>["content"][number];
    const nextContent: AssistantContentBlock[] = [];
    let contentChanged = false;
    for (const block of msg.content) {
      if (!block || typeof block !== "object" || (block as { type?: unknown }).type !== "thinking") {
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

function repairToolUseResultPairing(messages: AgentMessage[], allowSyntheticToolResults: boolean): {
  messages: AgentMessage[];
  addedCount: number;
  droppedDuplicateCount: number;
  droppedOrphanCount: number;
  moved: boolean;
} {
  const out: AgentMessage[] = [];
  const seenToolResultIds = new Set<string>();
  let addedCount = 0;
  let droppedDuplicateCount = 0;
  let droppedOrphanCount = 0;
  let moved = false;
  let changed = false;

  const pushToolResult = (msg: Extract<AgentMessage, { role: "toolResult" }>) => {
    const id = extractToolResultId(msg);
    if (id && seenToolResultIds.has(id)) {
      droppedDuplicateCount += 1;
      changed = true;
      return;
    }
    if (id) {
      seenToolResultIds.add(id);
    }
    out.push(msg);
  };

  for (let i = 0; i < messages.length; i += 1) {
    const msg = messages[i];
    if (!msg || typeof msg !== "object") {
      out.push(msg);
      continue;
    }

    if (msg.role !== "assistant") {
      if (msg.role !== "toolResult") {
        out.push(msg);
      } else {
        droppedOrphanCount += 1;
        changed = true;
      }
      continue;
    }

    const assistant = msg as Extract<AgentMessage, { role: "assistant" }>;
    if (assistant.stopReason === "error" || assistant.stopReason === "aborted") {
      out.push(msg);
      continue;
    }

    const toolCalls = extractToolCallsFromAssistant(assistant);
    if (toolCalls.length === 0) {
      out.push(msg);
      continue;
    }

    const toolCallIds = new Set(toolCalls.map((t) => t.id));
    const spanResultsById = new Map<string, Extract<AgentMessage, { role: "toolResult" }>>();
    const remainder: AgentMessage[] = [];

    let j = i + 1;
    for (; j < messages.length; j += 1) {
      const next = messages[j];
      if (!next || typeof next !== "object") {
        remainder.push(next);
        continue;
      }

      if (next.role === "assistant") {
        break;
      }

      if (next.role === "toolResult") {
        const toolResult = next as Extract<AgentMessage, { role: "toolResult" }>;
        const id = extractToolResultId(toolResult);
        if (id && toolCallIds.has(id)) {
          if (seenToolResultIds.has(id)) {
            droppedDuplicateCount += 1;
            changed = true;
            continue;
          }
          if (!spanResultsById.has(id)) {
            spanResultsById.set(id, toolResult);
          }
          continue;
        }
      }

      if (next.role !== "toolResult") {
        remainder.push(next);
      } else {
        droppedOrphanCount += 1;
        changed = true;
      }
    }

    out.push(msg);

    if (spanResultsById.size > 0 && remainder.length > 0) {
      moved = true;
      changed = true;
    }

    for (const call of toolCalls) {
      const existing = spanResultsById.get(call.id);
      if (existing) {
        pushToolResult(existing);
      } else if (allowSyntheticToolResults) {
        const missing = makeMissingToolResult({
          toolCallId: call.id,
          toolName: call.name,
        });
        addedCount += 1;
        changed = true;
        pushToolResult(missing);
      }
    }

    out.push(...remainder);
    i = j - 1;
  }

  return {
    messages: changed ? out : messages,
    addedCount,
    droppedDuplicateCount,
    droppedOrphanCount,
    moved: changed || moved,
  };
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
