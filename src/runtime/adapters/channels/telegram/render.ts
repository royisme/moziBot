import MarkdownIt from "markdown-it";
import { chunkText, CHANNEL_TEXT_LIMITS } from "../../../../utils/text-chunk";

const markdown = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: true,
});

const PARSE_ERROR_RE = /can't parse entities|Bad Request: can't parse entities/i;
const MESSAGE_NOT_MODIFIED_RE = /message is not modified/i;

/**
 * File extensions that share TLDs and commonly appear in code/documentation.
 * These are wrapped in <code> tags to prevent Telegram from generating
 * spurious domain registrar previews.
 */
const FILE_EXTENSIONS_WITH_TLD = new Set(["md", "go", "py", "pl", "sh", "am", "at", "be", "cc"]);

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

/** Detects when markdown-it linkify auto-generated a link from a bare filename. */
function isAutoLinkedFileRef(href: string, label: string): boolean {
  const stripped = stripTrailingSlash(href.replace(/^https?:\/\//i, ""));
  const normalizedLabel = stripTrailingSlash(label.trim());
  if (stripped !== normalizedLabel) {
    return false;
  }
  const dotIndex = normalizedLabel.lastIndexOf(".");
  if (dotIndex < 1) {
    return false;
  }
  const ext = normalizedLabel.slice(dotIndex + 1).toLowerCase();
  if (!FILE_EXTENSIONS_WITH_TLD.has(ext)) {
    return false;
  }
  const segments = normalizedLabel.split("/");
  if (segments.length > 1) {
    for (let i = 0; i < segments.length - 1; i++) {
      if (segments[i].includes(".")) {
        return false;
      }
    }
  }
  return true;
}

const FILE_EXTENSIONS_PATTERN = Array.from(FILE_EXTENSIONS_WITH_TLD).map(escapeRegex).join("|");
const FILE_REFERENCE_PATTERN = new RegExp(
  `(^|[^a-zA-Z0-9_\\-/])([a-zA-Z0-9_.\\-./]+\\.(?:${FILE_EXTENSIONS_PATTERN}))(?=$|[^a-zA-Z0-9_\\-/])`,
  "gi",
);
const ORPHANED_TLD_PATTERN = new RegExp(
  `([^a-zA-Z0-9]|^)([A-Za-z]\\.(?:${FILE_EXTENSIONS_PATTERN}))(?=[^a-zA-Z0-9/]|$)`,
  "g",
);
const HTML_TAG_PATTERN = /(<\/?)([a-zA-Z][a-zA-Z0-9-]*)\b[^>]*?>/gi;

function wrapStandaloneFileRef(match: string, prefix: string, filename: string): string {
  if (filename.startsWith("//")) {
    return match;
  }
  if (/https?:\/\/$/i.test(prefix)) {
    return match;
  }
  return `${prefix}<code>${escapeHtml(filename)}</code>`;
}

function wrapSegmentFileRefs(
  text: string,
  codeDepth: number,
  preDepth: number,
  anchorDepth: number,
): string {
  if (!text || codeDepth > 0 || preDepth > 0 || anchorDepth > 0) {
    return text;
  }
  const wrappedStandalone = text.replace(FILE_REFERENCE_PATTERN, wrapStandaloneFileRef);
  return wrappedStandalone.replace(ORPHANED_TLD_PATTERN, (match, prefix: string, tld: string) =>
    prefix === ">" ? match : `${prefix}<code>${escapeHtml(tld)}</code>`,
  );
}

function wrapFileReferencesInHtml(html: string): string {
  const deLinkified = html.replace(
    /<a\s+href="([^"]+)"[^>]*>([^<]+)<\/a>/gi,
    (match, href: string, label: string) => {
      if (!isAutoLinkedFileRef(href, label)) {
        return match;
      }
      return `<code>${escapeHtml(label)}</code>`;
    },
  );

  let codeDepth = 0;
  let preDepth = 0;
  let anchorDepth = 0;
  let result = "";
  let lastIndex = 0;

  HTML_TAG_PATTERN.lastIndex = 0;
  let tagMatch: RegExpExecArray | null;

  while ((tagMatch = HTML_TAG_PATTERN.exec(deLinkified)) !== null) {
    const tagStart = tagMatch.index;
    const tagEnd = HTML_TAG_PATTERN.lastIndex;
    const isClosing = tagMatch[1] === "</";
    const tagName = tagMatch[2].toLowerCase();

    const textBefore = deLinkified.slice(lastIndex, tagStart);
    result += wrapSegmentFileRefs(textBefore, codeDepth, preDepth, anchorDepth);

    if (tagName === "code") {
      codeDepth = isClosing ? Math.max(0, codeDepth - 1) : codeDepth + 1;
    } else if (tagName === "pre") {
      preDepth = isClosing ? Math.max(0, preDepth - 1) : preDepth + 1;
    } else if (tagName === "a") {
      anchorDepth = isClosing ? Math.max(0, anchorDepth - 1) : anchorDepth + 1;
    }

    result += deLinkified.slice(tagStart, tagEnd);
    lastIndex = tagEnd;
  }

  const remainingText = deLinkified.slice(lastIndex);
  result += wrapSegmentFileRefs(remainingText, codeDepth, preDepth, anchorDepth);

  return result;
}

function normalizeAllowedTags(html: string): string {
  let result = html;

  result = result.replace(/<strong>/gi, "<b>").replace(/<\/strong>/gi, "</b>");
  result = result.replace(/<em>/gi, "<i>").replace(/<\/em>/gi, "</i>");
  result = result.replace(/<del>/gi, "<s>").replace(/<\/del>/gi, "</s>");

  result = result.replace(/<h[1-6]>([\s\S]*?)<\/h[1-6]>/gi, "<b>$1</b>");

  result = result.replace(/<pre><code[^>]*>/gi, "<pre><code>");

  result = result.replace(/<li>([\s\S]*?)<\/li>/gi, (_match, item: string) => `• ${item}\n`);
  result = result.replace(/<\/?(?:ul|ol)>/gi, "");

  result = result.replace(/<blockquote>([\s\S]*?)<\/blockquote>/gi, (_match, quote: string) => {
    return quote
      .split("\n")
      .map((line) => (line.trim().length > 0 ? `> ${line}` : line))
      .join("\n");
  });

  result = result.replace(/^<p>/i, "").replace(/<\/p>$/i, "");
  result = result.replace(/<\/p>\s*<p>/gi, "\n\n");
  result = result.replace(/<br\s*\/?>/gi, "\n");

  result = result.replace(/<a\s+[^>]*href=("[^"]*"|'[^']*')[^>]*>/gi, "<a href=$1>");

  result = result.replace(/<(?!\/?(?:b|i|s|a|code|pre)(?:\s|>|$))\/?[^>]+>/gi, "");

  return result.replace(/\n{3,}/g, "\n\n").trim();
}

export function markdownToTelegramHtml(text: string): string {
  const rendered = markdown.render(text ?? "");
  const normalized = normalizeAllowedTags(rendered);
  return wrapFileReferencesInHtml(normalized);
}

export function isTelegramParseError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const record = error as Record<string, unknown>;
  const message = typeof record.message === "string" ? record.message : "";
  const description =
    typeof record.description === "string"
      ? record.description
      : typeof (record as { error?: { description?: string } }).error?.description === "string"
        ? (record as { error?: { description?: string } }).error?.description || ""
        : "";
  return PARSE_ERROR_RE.test(`${message} ${description}`);
}

export function isTelegramMessageNotModifiedError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const record = error as Record<string, unknown>;
  const message = typeof record.message === "string" ? record.message : "";
  const description =
    typeof record.description === "string"
      ? record.description
      : typeof (record as { error?: { description?: string } }).error?.description === "string"
        ? (record as { error?: { description?: string } }).error?.description || ""
        : "";
  return MESSAGE_NOT_MODIFIED_RE.test(`${message} ${description}`);
}

export const TELEGRAM_MAX_MESSAGE_LENGTH = CHANNEL_TEXT_LIMITS.telegram;

export function chunkMessage(text: string, maxLength = TELEGRAM_MAX_MESSAGE_LENGTH): string[] {
  if (!text) {
    return [""];
  }
  return chunkText(text, maxLength);
}
