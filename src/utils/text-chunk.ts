/**
 * Generic text chunking utilities for splitting long messages into
 * platform-appropriate chunks.
 *
 * Design inspired by OpenClaw's auto-reply/chunk.ts pattern.
 */

/**
 * Chunking mode for outbound messages:
 * - "length": Split only when exceeding limit (default)
 * - "paragraph": Prefer breaking on paragraph boundaries (blank lines)
 */
export type ChunkMode = "length" | "paragraph";

const DEFAULT_CHUNK_LIMIT = 4000;

export interface ChunkOptions {
  /** Maximum characters per chunk */
  limit?: number;
  /** Chunking mode */
  mode?: ChunkMode;
}

/**
 * Split text into chunks respecting the given limit.
 * Prefers breaking at natural boundaries (newlines, spaces).
 */
export function chunkText(text: string, limit = DEFAULT_CHUNK_LIMIT): string[] {
  if (!text) {
    return [];
  }
  if (limit <= 0) {
    return [text];
  }
  if (text.length <= limit) {
    return [text];
  }

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > limit) {
    const window = remaining.slice(0, limit);
    const breakpoint = findBestBreakpoint(window, limit);
    const breakIdx = breakpoint > 0 ? breakpoint : limit;

    const chunk = remaining.slice(0, breakIdx).trimEnd();
    if (chunk.length > 0) {
      chunks.push(chunk);
    }

    const brokeOnSeparator = breakIdx < remaining.length && /\s/.test(remaining[breakIdx]);
    const nextStart = Math.min(remaining.length, breakIdx + (brokeOnSeparator ? 1 : 0));
    remaining = remaining.slice(nextStart).trimStart();
  }

  if (remaining.length > 0) {
    chunks.push(remaining);
  }

  return chunks;
}

/**
 * Split text on paragraph boundaries (blank lines).
 * Packs multiple paragraphs into a single chunk up to limit.
 * Falls back to length-based splitting when a single paragraph exceeds limit.
 */
export function chunkByParagraph(
  text: string,
  limit = DEFAULT_CHUNK_LIMIT,
  opts?: { splitLongParagraphs?: boolean },
): string[] {
  if (!text) {
    return [];
  }
  if (limit <= 0) {
    return [text];
  }

  const splitLongParagraphs = opts?.splitLongParagraphs !== false;
  const normalized = text.replace(/\r\n?/g, "\n");

  // Detect paragraph separators (blank lines)
  const paragraphRe = /\n[\t ]*\n+/;
  if (!paragraphRe.test(normalized)) {
    if (normalized.length <= limit) {
      return [normalized];
    }
    return splitLongParagraphs ? chunkText(normalized, limit) : [normalized];
  }

  // Split on paragraph boundaries
  const parts: string[] = [];
  const re = /\n[\t ]*\n+/g;
  let lastIndex = 0;
  for (const match of normalized.matchAll(re)) {
    const idx = match.index ?? 0;
    parts.push(normalized.slice(lastIndex, idx));
    lastIndex = idx + match[0].length;
  }
  parts.push(normalized.slice(lastIndex));

  // Pack paragraphs into chunks
  const chunks: string[] = [];
  for (const part of parts) {
    const paragraph = part.replace(/\s+$/g, "");
    if (!paragraph.trim()) {
      continue;
    }
    if (paragraph.length <= limit) {
      chunks.push(paragraph);
    } else if (splitLongParagraphs) {
      chunks.push(...chunkText(paragraph, limit));
    } else {
      chunks.push(paragraph);
    }
  }

  return chunks;
}

/**
 * Unified chunking function that dispatches based on mode.
 */
export function chunkTextWithMode(text: string, limit: number, mode: ChunkMode): string[] {
  if (mode === "paragraph") {
    return chunkByParagraph(text, limit);
  }
  return chunkText(text, limit);
}

/**
 * Find the best breakpoint index within the window.
 * Priority: paragraph break > line break > sentence ending > word boundary
 */
function findBestBreakpoint(window: string, limit: number): number {
  // 1. Paragraph break (double newline)
  const paragraphBreak = window.lastIndexOf("\n\n");
  if (paragraphBreak > limit * 0.5) {
    return paragraphBreak + 2;
  }

  // 2. Line break
  const lineBreak = window.lastIndexOf("\n");
  if (lineBreak > limit * 0.3) {
    return lineBreak + 1;
  }

  // 3. Sentence endings
  const sentenceEndings = [". ", "。", "! ", "? ", "！", "？"];
  let bestSentenceEnd = -1;
  for (const ending of sentenceEndings) {
    const idx = window.lastIndexOf(ending);
    if (idx > bestSentenceEnd) {
      bestSentenceEnd = idx + ending.length;
    }
  }
  if (bestSentenceEnd > limit * 0.3) {
    return bestSentenceEnd;
  }

  // 4. Word boundary (space)
  const lastSpace = window.lastIndexOf(" ");
  if (lastSpace > limit * 0.3) {
    return lastSpace + 1;
  }

  // 5. No good break found, hard break at limit
  return limit;
}

/**
 * Channel-specific text limits.
 * These are safe limits that account for potential HTML/formatting overhead.
 */
export const CHANNEL_TEXT_LIMITS = {
  telegram: 4096,
  discord: 2000,
  slack: 40000,
  default: 4000,
} as const;

export type ChannelId = keyof typeof CHANNEL_TEXT_LIMITS;

/**
 * Get the text chunk limit for a specific channel.
 */
export function getChannelTextLimit(channelId: string): number {
  const id = channelId.toLowerCase() as ChannelId;
  return CHANNEL_TEXT_LIMITS[id] ?? CHANNEL_TEXT_LIMITS.default;
}
