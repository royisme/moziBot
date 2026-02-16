import { describe, expect, it } from "vitest";
import {
  chunkMessage,
  isTelegramMessageNotModifiedError,
  isTelegramParseError,
  markdownToTelegramHtml,
  TELEGRAM_MAX_MESSAGE_LENGTH,
} from "./render";

describe("telegram render", () => {
  it("renders basic markdown to telegram-safe html", () => {
    const rendered = markdownToTelegramHtml("**bold** _italic_ `code`");
    expect(rendered).toContain("<b>bold</b>");
    expect(rendered).toContain("<i>italic</i>");
    expect(rendered).toContain("<code>code</code>");
  });

  it("renders links and strips unsupported tags", () => {
    const rendered = markdownToTelegramHtml("# Title\n\n[docs](https://example.com)");
    expect(rendered).toContain("<b>Title</b>");
    expect(rendered).toContain('<a href="https://example.com">docs</a>');
    expect(rendered).not.toContain("<h1>");
  });

  it("detects telegram parse errors", () => {
    expect(
      isTelegramParseError({
        message: "400: Bad Request: can't parse entities: unsupported start tag",
      }),
    ).toBe(true);
    expect(isTelegramParseError({ message: "network timeout" })).toBe(false);
  });

  it("detects telegram message-not-modified errors", () => {
    expect(
      isTelegramMessageNotModifiedError({
        description: "Bad Request: message is not modified",
      }),
    ).toBe(true);
    expect(isTelegramMessageNotModifiedError({ message: "network timeout" })).toBe(false);
  });
});

describe("chunkMessage", () => {
  it("returns single-element array for short messages", () => {
    const text = "Hello, world!";
    const chunks = chunkMessage(text);
    expect(chunks).toEqual([text]);
  });

  it("returns single-element array for messages at the limit", () => {
    const text = "a".repeat(TELEGRAM_MAX_MESSAGE_LENGTH);
    const chunks = chunkMessage(text);
    expect(chunks).toEqual([text]);
  });

  it("splits long messages into multiple chunks", () => {
    const text = "a".repeat(TELEGRAM_MAX_MESSAGE_LENGTH + 100);
    const chunks = chunkMessage(text);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join("").length).toBe(text.length);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(TELEGRAM_MAX_MESSAGE_LENGTH);
    }
  });

  it("prefers splitting at paragraph breaks", () => {
    const paragraph1 = "First paragraph. " + "a".repeat(3000);
    const paragraph2 = "Second paragraph. " + "b".repeat(2000);
    const text = paragraph1 + "\n\n" + paragraph2;
    const chunks = chunkMessage(text);
    expect(chunks.length).toBe(2);
    expect(chunks[0]).toContain("First paragraph");
    expect(chunks[1]).toContain("Second paragraph");
  });

  it("prefers splitting at line breaks when no paragraph break", () => {
    const line1 = "a".repeat(3000);
    const line2 = "b".repeat(2000);
    const text = line1 + "\n" + line2;
    const chunks = chunkMessage(text);
    expect(chunks.length).toBe(2);
    expect(chunks[0]).toBe(line1);
    expect(chunks[1]).toBe(line2);
  });

  it("prefers splitting at sentence endings", () => {
    const sentence1 = "a".repeat(2500) + ". ";
    const sentence2 = "b".repeat(2500);
    const text = sentence1 + sentence2;
    const chunks = chunkMessage(text);
    expect(chunks.length).toBe(2);
    expect(chunks[0].endsWith(". ") || chunks[0].endsWith(".")).toBe(true);
  });

  it("handles empty string", () => {
    const chunks = chunkMessage("");
    expect(chunks).toEqual([""]);
  });

  it("handles very long text with no natural break points", () => {
    const text = "a".repeat(10000);
    const chunks = chunkMessage(text);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(TELEGRAM_MAX_MESSAGE_LENGTH);
    }
    expect(chunks.join("").length).toBe(text.length);
  });
});
