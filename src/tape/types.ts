// Tape System Type Definitions

export type TapeEntryKind = "message" | "tool_call" | "tool_result" | "anchor" | "event" | "system";

export interface TapeEntry {
  id: number;
  kind: TapeEntryKind;
  payload: Record<string, unknown>;
  meta: Record<string, unknown>;
}

export interface AnchorPayload {
  name: string;
  state?: {
    owner?: string;
    summary?: string;
    nextSteps?: string[];
    [key: string]: unknown;
  };
}

export interface AnchorSummary {
  name: string;
  state: Record<string, unknown>;
}

export interface TapeInfo {
  name: string;
  entries: number;
  anchors: number;
  lastAnchor: string | null;
  entriesSinceLastAnchor: number;
}

// Factory functions for creating TapeEntry instances
export function createMessage(
  role: string,
  content: string,
  meta?: Record<string, unknown>,
): Omit<TapeEntry, "id"> {
  return {
    kind: "message",
    payload: { role, content },
    meta: meta ?? {},
  };
}

export function createToolCall(
  calls: Record<string, unknown>[],
  meta?: Record<string, unknown>,
): Omit<TapeEntry, "id"> {
  return {
    kind: "tool_call",
    payload: { calls },
    meta: meta ?? {},
  };
}

export function createToolResult(
  results: unknown[],
  meta?: Record<string, unknown>,
): Omit<TapeEntry, "id"> {
  return {
    kind: "tool_result",
    payload: { results },
    meta: meta ?? {},
  };
}

export function createAnchor(
  name: string,
  state?: AnchorPayload["state"],
  meta?: Record<string, unknown>,
): Omit<TapeEntry, "id"> {
  return {
    kind: "anchor",
    payload: { name, state },
    meta: meta ?? {},
  };
}

export function createEvent(
  name: string,
  data: Record<string, unknown>,
  meta?: Record<string, unknown>,
): Omit<TapeEntry, "id"> {
  return {
    kind: "event",
    payload: { name, data },
    meta: meta ?? {},
  };
}

export function createSystem(
  content: string,
  meta?: Record<string, unknown>,
): Omit<TapeEntry, "id"> {
  return {
    kind: "system",
    payload: { content },
    meta: meta ?? {},
  };
}
