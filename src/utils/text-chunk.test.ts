import { describe, expect, it } from "vitest";
import {
  chunkText,
  chunkByParagraph,
  chunkTextWithMode,
  getChannelTextLimit,
  CHANNEL_TEXT_LIMITS,
} from "./text-chunk";

describe("chunkText", () => {
  it("returns empty array for empty string", () => {
    expect(chunkText("")).toEqual([]);
  });

  it("returns single chunk for text under limit", () => {
    const text = "Hello, world!";
    expect(chunkText(text, 100)).toEqual([text]);
  });

  it("returns single chunk for text at limit", () => {
    const text = "a".repeat(100);
    expect(chunkText(text, 100)).toEqual([text]);
  });

  it("splits long text into multiple chunks", () => {
    const text = "a".repeat(250);
    const chunks = chunkText(text, 100);
    expect(chunks.length).toBe(3);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(100);
    }
    expect(chunks.join("").length).toBe(text.length);
  });

  it("prefers breaking at newlines", () => {
    const line1 = "a".repeat(80);
    const line2 = "b".repeat(80);
    const text = `${line1}\n${line2}`;
    const chunks = chunkText(text, 100);
    expect(chunks.length).toBe(2);
    expect(chunks[0]).toBe(line1);
    expect(chunks[1]).toBe(line2);
  });

  it("prefers breaking at spaces over hard break", () => {
    const text = "word ".repeat(25).trim();
    const chunks = chunkText(text, 50);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(50);
    }
  });

  it("handles text with no natural break points", () => {
    const text = "a".repeat(500);
    const chunks = chunkText(text, 100);
    expect(chunks.length).toBe(5);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(100);
    }
  });
});

describe("chunkByParagraph", () => {
  it("returns empty array for empty string", () => {
    expect(chunkByParagraph("")).toEqual([]);
  });

  it("returns single chunk when no paragraph breaks", () => {
    const text = "Hello world\nSecond line";
    expect(chunkByParagraph(text, 1000)).toEqual([text]);
  });

  it("splits on paragraph boundaries", () => {
    const para1 = "First paragraph.";
    const para2 = "Second paragraph.";
    const text = `${para1}\n\n${para2}`;
    const chunks = chunkByParagraph(text, 1000);
    expect(chunks.length).toBe(2);
    expect(chunks[0]).toBe(para1);
    expect(chunks[1]).toBe(para2);
  });

  it("handles multiple blank lines between paragraphs", () => {
    const para1 = "First.";
    const para2 = "Second.";
    const text = `${para1}\n\n\n\n${para2}`;
    const chunks = chunkByParagraph(text, 1000);
    expect(chunks.length).toBe(2);
  });

  it("falls back to length-based split for long paragraphs", () => {
    const longPara = "a".repeat(500);
    const chunks = chunkByParagraph(longPara, 100);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(100);
    }
  });

  it("respects splitLongParagraphs:false option", () => {
    const longPara = "a".repeat(500);
    const chunks = chunkByParagraph(longPara, 100, { splitLongParagraphs: false });
    expect(chunks.length).toBe(1);
    expect(chunks[0]).toBe(longPara);
  });
});

describe("chunkTextWithMode", () => {
  it("uses chunkText for length mode", () => {
    const text = "a".repeat(200);
    const chunks = chunkTextWithMode(text, 100, "length");
    expect(chunks.length).toBe(2);
  });

  it("uses chunkByParagraph for paragraph mode", () => {
    const text = "First.\n\nSecond.";
    const chunks = chunkTextWithMode(text, 1000, "paragraph");
    expect(chunks.length).toBe(2);
  });
});

describe("getChannelTextLimit", () => {
  it("returns telegram limit", () => {
    expect(getChannelTextLimit("telegram")).toBe(CHANNEL_TEXT_LIMITS.telegram);
  });

  it("returns discord limit", () => {
    expect(getChannelTextLimit("discord")).toBe(CHANNEL_TEXT_LIMITS.discord);
  });

  it("returns default for unknown channel", () => {
    expect(getChannelTextLimit("unknown")).toBe(CHANNEL_TEXT_LIMITS.default);
  });

  it("is case insensitive", () => {
    expect(getChannelTextLimit("Telegram")).toBe(CHANNEL_TEXT_LIMITS.telegram);
    expect(getChannelTextLimit("DISCORD")).toBe(CHANNEL_TEXT_LIMITS.discord);
  });
});
