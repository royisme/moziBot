export const SILENT_REPLY_TOKEN = "NO_REPLY";

export type ReplyToolCallMode = "off" | "summary";

export type ReplyRenderOptions = {
  showThinking?: boolean;
  showToolCalls?: ReplyToolCallMode;
};

type AssistantMessageMeta = {
  stopReason?: unknown;
  errorMessage?: unknown;
};

type CollectedReplyParts = {
  textParts: string[];
  thinkingParts: string[];
  toolCalls: Array<{ name?: string; arguments?: unknown }>;
};

interface CodeRegion {
  start: number;
  end: number;
}

const THINKING_TAG_RE = /<\s*(\/?)\s*(?:think(?:ing)?|thought|antthinking)\b[^<>]*>/gi;
const QUICK_THINKING_TAG_RE = /<\s*\/?\s*(?:think(?:ing)?|thought|antthinking)\b/i;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function findCodeRegions(text: string): CodeRegion[] {
  const regions: CodeRegion[] = [];

  const fencedRe = /(^|\n)(```|~~~)[^\n]*\n[\s\S]*?(?:\n\2(?:\n|$)|$)/g;
  for (const match of text.matchAll(fencedRe)) {
    const start = (match.index ?? 0) + match[1].length;
    regions.push({ start, end: start + match[0].length - match[1].length });
  }

  const inlineRe = /`+[^`]+`+/g;
  for (const match of text.matchAll(inlineRe)) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    const insideFenced = regions.some((r) => start >= r.start && end <= r.end);
    if (!insideFenced) {
      regions.push({ start, end });
    }
  }

  regions.sort((a, b) => a.start - b.start);
  return regions;
}

function isInsideCode(pos: number, regions: CodeRegion[]): boolean {
  return regions.some((r) => pos >= r.start && pos < r.end);
}

function stripReasoningTagsFromText(text: string): string {
  if (!text) {
    return text;
  }
  if (!QUICK_THINKING_TAG_RE.test(text)) {
    return text;
  }

  const codeRegions = findCodeRegions(text);
  THINKING_TAG_RE.lastIndex = 0;

  let result = "";
  let lastIndex = 0;
  let inThinking = false;

  for (const match of text.matchAll(THINKING_TAG_RE)) {
    const idx = match.index ?? 0;
    const isClose = match[1] === "/";

    if (isInsideCode(idx, codeRegions)) {
      continue;
    }

    if (!inThinking) {
      result += text.slice(lastIndex, idx);
      if (!isClose) {
        inThinking = true;
      }
    } else if (isClose) {
      inThinking = false;
    }

    lastIndex = idx + match[0].length;
  }

  if (!inThinking) {
    result += text.slice(lastIndex);
  }

  return result.trim();
}

function extractThinkingFromTaggedText(text: string): string {
  if (!text || !QUICK_THINKING_TAG_RE.test(text)) {
    return "";
  }

  const codeRegions = findCodeRegions(text);
  THINKING_TAG_RE.lastIndex = 0;

  let result = "";
  let lastIndex = 0;
  let inThinking = false;

  for (const match of text.matchAll(THINKING_TAG_RE)) {
    const idx = match.index ?? 0;
    if (isInsideCode(idx, codeRegions)) {
      continue;
    }
    if (inThinking) {
      result += text.slice(lastIndex, idx);
    }
    const isClose = match[1] === "/";
    inThinking = !isClose;
    lastIndex = idx + match[0].length;
  }

  return result.trim();
}

function formatToolArgumentsPreview(args: unknown): string {
  if (args == null) {
    return "";
  }
  if (typeof args === "string") {
    const trimmed = args.trim();
    if (!trimmed) {
      return "";
    }
    return trimmed.length > 80 ? `${trimmed.slice(0, 80)}...` : trimmed;
  }
  if (typeof args !== "object") {
    if (typeof args === "number" || typeof args === "boolean" || typeof args === "bigint") {
      return `${args}`;
    }
    if (typeof args === "symbol") {
      return args.description ? `Symbol(${args.description})` : "Symbol";
    }
    return "";
  }
  const keys = Object.keys(args as Record<string, unknown>);
  if (keys.length === 0) {
    return "";
  }
  const shown = keys.slice(0, 3).join(", ");
  return keys.length > 3 ? `${shown}, ...` : shown;
}

function collectReplyParts(content: unknown, out: CollectedReplyParts): void {
  if (content == null) {
    return;
  }
  if (typeof content === "string") {
    out.textParts.push(content);
    const taggedThinking = extractThinkingFromTaggedText(content);
    if (taggedThinking) {
      out.thinkingParts.push(taggedThinking);
    }
    return;
  }
  if (Array.isArray(content)) {
    for (const item of content) {
      collectReplyParts(item, out);
    }
    return;
  }
  if (typeof content !== "object") {
    return;
  }

  const record = content as Record<string, unknown>;
  const type = typeof record.type === "string" ? record.type : "";

  if (type === "thinking" && typeof record.thinking === "string") {
    const thinking = record.thinking.trim();
    if (thinking) {
      out.thinkingParts.push(thinking);
    }
  }

  if (type === "toolCall") {
    out.toolCalls.push({
      name: typeof record.name === "string" ? record.name : undefined,
      arguments: record.arguments,
    });
  }

  if (typeof record.text === "string") {
    out.textParts.push(record.text);
    const taggedThinking = extractThinkingFromTaggedText(record.text);
    if (taggedThinking) {
      out.thinkingParts.push(taggedThinking);
    }
  }

  if (typeof record.output_text === "string") {
    out.textParts.push(record.output_text);
    const taggedThinking = extractThinkingFromTaggedText(record.output_text);
    if (taggedThinking) {
      out.thinkingParts.push(taggedThinking);
    }
  }

  if (Array.isArray(record.content)) {
    collectReplyParts(record.content, out);
  }
}

function buildToolSummary(toolCalls: Array<{ name?: string; arguments?: unknown }>): string {
  if (toolCalls.length === 0) {
    return "";
  }
  const lines = toolCalls.map((call, index) => {
    const name = call.name?.trim() || `tool_${index + 1}`;
    const args = formatToolArgumentsPreview(call.arguments);
    return args ? `- ${name} (${args})` : `- ${name}`;
  });
  return `Tool calls:\n${lines.join("\n")}`;
}

function normalizeThinkingParts(parts: string[]): string {
  const joined = parts
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .join("\n")
    .trim();
  if (!joined) {
    return "";
  }
  return `Reasoning:\n${joined}`;
}

export function isSilentReplyText(
  text: string | undefined,
  token: string = SILENT_REPLY_TOKEN,
): boolean {
  if (!text) {
    return false;
  }
  const escaped = escapeRegExp(token);
  const prefix = new RegExp(`^\\s*${escaped}(?=$|\\W)`);
  if (prefix.test(text)) {
    return true;
  }
  const suffix = new RegExp(`\\b${escaped}\\b\\W*$`);
  return suffix.test(text);
}

export function extractAssistantText(content: unknown): string {
  const parts: CollectedReplyParts = {
    textParts: [],
    thinkingParts: [],
    toolCalls: [],
  };
  collectReplyParts(content, parts);
  return parts.textParts.map((part) => stripReasoningTagsFromText(part)).join("");
}

export function renderAssistantReply(content: unknown, options: ReplyRenderOptions = {}): string {
  const showThinking = options.showThinking === true;
  const toolMode = options.showToolCalls ?? "off";

  const parts: CollectedReplyParts = {
    textParts: [],
    thinkingParts: [],
    toolCalls: [],
  };
  collectReplyParts(content, parts);

  const text = parts.textParts
    .map((part) => (showThinking ? part : stripReasoningTagsFromText(part)))
    .join("")
    .trim();

  const sections: string[] = [];

  if (showThinking) {
    const thinking = normalizeThinkingParts(parts.thinkingParts);
    if (thinking) {
      sections.push(thinking);
    }
  }

  if (text) {
    sections.push(text);
  }

  if (toolMode === "summary") {
    const summary = buildToolSummary(parts.toolCalls);
    if (summary) {
      sections.push(summary);
    }
  }

  return sections.join("\n\n").trim();
}

export function getAssistantFailureReason(message: unknown): string | null {
  if (!message || typeof message !== "object") {
    return null;
  }
  const meta = message as AssistantMessageMeta;
  const errorMessage = typeof meta.errorMessage === "string" ? meta.errorMessage.trim() : "";
  if (errorMessage) {
    return errorMessage;
  }
  if (meta.stopReason === "error") {
    return "assistant returned stopReason=error";
  }
  return null;
}
