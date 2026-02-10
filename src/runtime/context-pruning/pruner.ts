import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { ImageContent, TextContent, ToolResultMessage } from "@mariozechner/pi-ai";
import type { EffectiveContextPruningSettings } from "./settings";

const CHARS_PER_TOKEN = 4;
const IMAGE_CHAR_ESTIMATE = 8_000;

export type PruningStats = {
  softTrimCount: number;
  hardClearCount: number;
  charsBefore: number;
  charsAfter: number;
  charsSaved: number;
  ratio: number;
};

export type PruningResult = {
  messages: AgentMessage[];
  stats: PruningStats;
};

function asText(text: string): TextContent {
  return { type: "text", text };
}

function collectTextSegments(content: ReadonlyArray<TextContent | ImageContent>): string[] {
  const parts: string[] = [];
  for (const block of content) {
    if (block.type === "text") {
      parts.push(block.text);
    }
  }
  return parts;
}

function estimateJoinedTextLength(parts: string[]): number {
  if (parts.length === 0) {
    return 0;
  }
  let len = 0;
  for (const p of parts) {
    len += p.length;
  }
  len += Math.max(0, parts.length - 1);
  return len;
}

function takeHeadFromJoinedText(parts: string[], maxChars: number): string {
  if (maxChars <= 0 || parts.length === 0) {
    return "";
  }
  let remaining = maxChars;
  let out = "";
  for (let i = 0; i < parts.length && remaining > 0; i++) {
    if (i > 0) {
      out += "\n";
      remaining -= 1;
      if (remaining <= 0) {
        break;
      }
    }
    const p = parts[i];
    if (p.length <= remaining) {
      out += p;
      remaining -= p.length;
    } else {
      out += p.slice(0, remaining);
      remaining = 0;
    }
  }
  return out;
}

function takeTailFromJoinedText(parts: string[], maxChars: number): string {
  if (maxChars <= 0 || parts.length === 0) {
    return "";
  }
  let remaining = maxChars;
  const out: string[] = [];
  for (let i = parts.length - 1; i >= 0 && remaining > 0; i--) {
    const p = parts[i];
    if (p.length <= remaining) {
      out.push(p);
      remaining -= p.length;
    } else {
      out.push(p.slice(p.length - remaining));
      remaining = 0;
      break;
    }
    if (remaining > 0 && i > 0) {
      out.push("\n");
      remaining -= 1;
    }
  }
  out.reverse();
  return out.join("");
}

function hasImageBlocks(content: ReadonlyArray<TextContent | ImageContent>): boolean {
  for (const block of content) {
    if (block.type === "image") {
      return true;
    }
  }
  return false;
}

function estimateMessageChars(message: AgentMessage): number {
  if (message.role === "user") {
    const content = message.content;
    if (typeof content === "string") {
      return content.length;
    }
    let chars = 0;
    for (const b of content) {
      if (b.type === "text") {
        chars += b.text.length;
      }
      if (b.type === "image") {
        chars += IMAGE_CHAR_ESTIMATE;
      }
    }
    return chars;
  }

  if (message.role === "assistant") {
    let chars = 0;
    for (const b of message.content) {
      if (b.type === "text") {
        chars += b.text.length;
      }
      if (b.type === "thinking") {
        chars += b.thinking.length;
      }
      if (b.type === "toolCall") {
        try {
          chars += JSON.stringify(b.arguments ?? {}).length;
        } catch {
          chars += 128;
        }
      }
    }
    return chars;
  }

  if (message.role === "toolResult") {
    let chars = 0;
    for (const b of message.content) {
      if (b.type === "text") {
        chars += b.text.length;
      }
      if (b.type === "image") {
        chars += IMAGE_CHAR_ESTIMATE;
      }
    }
    return chars;
  }

  return 256;
}

function findAssistantCutoff(messages: AgentMessage[], keepLast: number): number | null {
  if (keepLast <= 0) {
    return messages.length;
  }

  let remaining = keepLast;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "assistant") {
      remaining--;
      if (remaining === 0) {
        return i;
      }
    }
  }
  return null;
}

function findFirstUserIndex(messages: AgentMessage[]): number | null {
  for (let i = 0; i < messages.length; i++) {
    if (messages[i]?.role === "user") {
      return i;
    }
  }
  return null;
}

function softTrimToolResultMessage(params: {
  msg: ToolResultMessage;
  settings: EffectiveContextPruningSettings;
}): ToolResultMessage | null {
  const { msg, settings } = params;
  if (hasImageBlocks(msg.content)) {
    return null;
  }

  const parts = collectTextSegments(msg.content);
  const rawLen = estimateJoinedTextLength(parts);

  if (rawLen <= settings.softTrim.maxChars) {
    return null;
  }

  const { headChars, tailChars } = settings.softTrim;
  if (headChars + tailChars >= rawLen) {
    return null;
  }

  const head = takeHeadFromJoinedText(parts, headChars);
  const tail = takeTailFromJoinedText(parts, tailChars);
  const trimmed = `${head}\n...\n${tail}`;
  const note = `\n\n[Trimmed: kept first ${headChars} and last ${tailChars} of ${rawLen} chars]`;

  return { ...msg, content: [asText(trimmed + note)] };
}

export function pruneContextMessages(params: {
  messages: AgentMessage[];
  settings: EffectiveContextPruningSettings;
  contextWindowTokens: number;
}): PruningResult {
  const emptyStats: PruningStats = {
    softTrimCount: 0,
    hardClearCount: 0,
    charsBefore: 0,
    charsAfter: 0,
    charsSaved: 0,
    ratio: 0,
  };

  if (!params.settings.enabled) {
    return { messages: params.messages, stats: emptyStats };
  }

  const { settings, contextWindowTokens } = params;
  if (contextWindowTokens <= 0) {
    return { messages: params.messages, stats: emptyStats };
  }

  const messages = params.messages;
  const charWindow = contextWindowTokens * CHARS_PER_TOKEN;

  const cutoffIndex = findAssistantCutoff(messages, settings.keepLastAssistants);
  if (cutoffIndex === null) {
    return { messages: params.messages, stats: emptyStats };
  }

  const firstUserIndex = findFirstUserIndex(messages);
  const pruneStart = firstUserIndex === null ? messages.length : firstUserIndex;

  const totalCharsBefore = messages.reduce((sum, m) => sum + estimateMessageChars(m), 0);
  let totalChars = totalCharsBefore;
  let ratio = totalChars / charWindow;

  if (ratio < settings.softTrimRatio) {
    return { messages: params.messages, stats: emptyStats };
  }

  const prunableIndexes: number[] = [];
  let result: AgentMessage[] | null = null;
  let softTrimCount = 0;
  let hardClearCount = 0;

  for (let i = pruneStart; i < cutoffIndex; i++) {
    const msg = messages[i];
    if (!msg || msg.role !== "toolResult") {
      continue;
    }
    if (msg.toolName && settings.protectedTools.has(msg.toolName)) {
      continue;
    }
    if (hasImageBlocks(msg.content)) {
      continue;
    }

    prunableIndexes.push(i);

    const trimmed = softTrimToolResultMessage({ msg, settings });
    if (!trimmed) {
      continue;
    }

    const beforeChars = estimateMessageChars(msg);
    const afterChars = estimateMessageChars(trimmed as unknown as AgentMessage);
    totalChars += afterChars - beforeChars;
    softTrimCount++;

    if (!result) {
      result = [...messages];
    }
    result[i] = trimmed as unknown as AgentMessage;
  }

  const afterSoftTrim = result ?? messages;
  ratio = totalChars / charWindow;

  if (ratio < settings.hardClearRatio) {
    const charsAfter = afterSoftTrim.reduce((sum, m) => sum + estimateMessageChars(m), 0);
    return {
      messages: afterSoftTrim,
      stats: {
        softTrimCount,
        hardClearCount,
        charsBefore: totalCharsBefore,
        charsAfter,
        charsSaved: totalCharsBefore - charsAfter,
        ratio: charsAfter / charWindow,
      },
    };
  }

  let prunableChars = 0;
  for (const i of prunableIndexes) {
    const msg = afterSoftTrim[i];
    if (msg?.role === "toolResult") {
      prunableChars += estimateMessageChars(msg);
    }
  }

  if (prunableChars < settings.minPrunableChars) {
    const charsAfter = afterSoftTrim.reduce((sum, m) => sum + estimateMessageChars(m), 0);
    return {
      messages: afterSoftTrim,
      stats: {
        softTrimCount,
        hardClearCount,
        charsBefore: totalCharsBefore,
        charsAfter,
        charsSaved: totalCharsBefore - charsAfter,
        ratio: charsAfter / charWindow,
      },
    };
  }

  for (const i of prunableIndexes) {
    if (ratio < settings.hardClearRatio) {
      break;
    }

    const msg = (result ?? messages)[i];
    if (!msg || msg.role !== "toolResult") {
      continue;
    }

    const beforeChars = estimateMessageChars(msg);
    const cleared: ToolResultMessage = {
      ...msg,
      content: [asText(settings.hardClearPlaceholder)],
    };

    if (!result) {
      result = [...messages];
    }
    result[i] = cleared as unknown as AgentMessage;
    hardClearCount++;

    const afterChars = estimateMessageChars(cleared as unknown as AgentMessage);
    totalChars += afterChars - beforeChars;
    ratio = totalChars / charWindow;
  }

  const finalMessages = result ?? messages;
  const charsAfter = finalMessages.reduce((sum, m) => sum + estimateMessageChars(m), 0);

  return {
    messages: finalMessages,
    stats: {
      softTrimCount,
      hardClearCount,
      charsBefore: totalCharsBefore,
      charsAfter,
      charsSaved: totalCharsBefore - charsAfter,
      ratio: charsAfter / charWindow,
    },
  };
}
