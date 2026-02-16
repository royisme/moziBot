import MarkdownIt from "markdown-it";
import { chunkText, CHANNEL_TEXT_LIMITS } from "../../../../utils/text-chunk";

const markdown = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: true,
});

const PARSE_ERROR_RE = /can't parse entities|Bad Request: can't parse entities/i;
const MESSAGE_NOT_MODIFIED_RE = /message is not modified/i;

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
  return normalizeAllowedTags(rendered);
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
