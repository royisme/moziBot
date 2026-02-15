import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { ToolCallIdMode } from "../transcript-policy";

const TOOL_CALL_TYPES = new Set(["toolCall", "toolUse", "functionCall"]);
const GEMINI_TOOL_ID_RE = /^[A-Za-z0-9_-]+$/;

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

export function extractToolCallsFromAssistant(
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

export function repairToolCallInputs(messages: AgentMessage[]): {
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

export function normalizeToolCallId(
  id: string,
  fallbackSeed: number,
  mode: ToolCallIdMode,
): string {
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

export function sanitizeToolCallIdsForProvider(
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
        if (
          typeof rec.type !== "string" ||
          !TOOL_CALL_TYPES.has(rec.type) ||
          typeof rec.id !== "string"
        ) {
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

export function repairToolUseResultPairing(
  messages: AgentMessage[],
  allowSyntheticToolResults: boolean,
): {
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

    const assistant = msg;
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
        const toolResult = next;
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
