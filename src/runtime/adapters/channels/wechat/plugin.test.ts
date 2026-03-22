import { describe, it, expect, beforeEach } from "vitest";
import { weixinMessageToInbound } from "./inbound";
import { contextTokenStore, getContextToken, setContextToken } from "./inbound";
import { markdownToPlainText } from "./send";
import type { WeixinMessage } from "./types";
import { MessageItemType } from "./types";

// ---------------------------------------------------------------------------
// weixinMessageToInbound
// ---------------------------------------------------------------------------

describe("weixinMessageToInbound", () => {
  beforeEach(() => {
    contextTokenStore.clear();
  });

  it("converts a TEXT message to InboundMessage", () => {
    const msg: WeixinMessage = {
      message_id: 42,
      from_user_id: "user_abc",
      create_time_ms: 1_700_000_000_000,
      context_token: "tok_123",
      item_list: [
        {
          type: MessageItemType.TEXT,
          text_item: { text: "Hello world" },
        },
      ],
    };

    const result = weixinMessageToInbound(msg, "wechat");

    expect(result).not.toBeNull();
    expect(result!.id).toBe("42");
    expect(result!.channel).toBe("wechat");
    expect(result!.peerId).toBe("user_abc");
    expect(result!.senderId).toBe("user_abc");
    expect(result!.peerType).toBe("dm");
    expect(result!.text).toBe("Hello world");
    expect(result!.timestamp).toEqual(new Date(1_700_000_000_000));
  });

  it("converts a VOICE message with ASR text", () => {
    const msg: WeixinMessage = {
      message_id: 99,
      from_user_id: "user_voice",
      context_token: "tok_voice",
      item_list: [
        {
          type: MessageItemType.VOICE,
          voice_item: { text: "transcribed voice text" },
        },
      ],
    };

    const result = weixinMessageToInbound(msg, "wechat");

    expect(result).not.toBeNull();
    expect(result!.text).toBe("transcribed voice text");
  });

  it("prepends [引用: ...] for message with ref_msg quote", () => {
    const msg: WeixinMessage = {
      message_id: 7,
      from_user_id: "user_quote",
      context_token: "tok_q",
      item_list: [
        {
          type: MessageItemType.TEXT,
          text_item: { text: "My reply" },
          ref_msg: {
            title: "Original message title",
          },
        },
      ],
    };

    const result = weixinMessageToInbound(msg, "wechat");

    expect(result).not.toBeNull();
    expect(result!.text).toContain("[引用:");
    expect(result!.text).toContain("Original message title");
    expect(result!.text).toContain("My reply");
  });

  it("returns null for empty item_list (message silently dropped)", () => {
    const msg: WeixinMessage = {
      message_id: 1,
      from_user_id: "user_empty",
      context_token: "tok_e",
      item_list: [],
    };

    const result = weixinMessageToInbound(msg, "wechat");
    expect(result).toBeNull();
  });

  it("returns null when no TEXT or VOICE-with-text items (message silently dropped)", () => {
    const msg: WeixinMessage = {
      message_id: 2,
      from_user_id: "user_img",
      context_token: "tok_img",
      item_list: [
        {
          type: MessageItemType.IMAGE,
          image_item: { url: "https://cdn.example.com/img.jpg" },
        },
      ],
    };

    const result = weixinMessageToInbound(msg, "wechat");
    expect(result).toBeNull();
  });

  it("stores context token on conversion", () => {
    contextTokenStore.clear();
    const msg: WeixinMessage = {
      message_id: 10,
      from_user_id: "user_ctx",
      context_token: "stored_token_xyz",
      item_list: [
        {
          type: MessageItemType.TEXT,
          text_item: { text: "hello" },
        },
      ],
    };

    weixinMessageToInbound(msg, "wechat");
    expect(getContextToken("user_ctx")).toBe("stored_token_xyz");
  });
});

// ---------------------------------------------------------------------------
// markdownToPlainText
// ---------------------------------------------------------------------------

describe("markdownToPlainText", () => {
  it("strips code fences but keeps code content", () => {
    const input = "Here is code:\n```typescript\nconst x = 1;\n```\nDone.";
    const result = markdownToPlainText(input);
    expect(result).toContain("const x = 1;");
    expect(result).not.toContain("```");
  });

  it("removes images entirely", () => {
    const input = "Look at this: ![alt text](https://example.com/image.png)";
    const result = markdownToPlainText(input);
    expect(result).not.toContain("![");
    expect(result).not.toContain("image.png");
  });

  it("converts links to display text only", () => {
    const input = "Visit [Google](https://google.com) for more.";
    const result = markdownToPlainText(input);
    expect(result).toContain("Google");
    expect(result).not.toContain("https://google.com");
    expect(result).not.toContain("[");
  });

  it("strips bold markers", () => {
    const input = "This is **important** text.";
    const result = markdownToPlainText(input);
    expect(result).toContain("important");
    expect(result).not.toContain("**");
  });

  it("strips headers", () => {
    const input = "# Heading 1\n## Heading 2\nSome body text.";
    const result = markdownToPlainText(input);
    expect(result).toContain("Heading 1");
    expect(result).not.toContain("# ");
    expect(result).not.toContain("## ");
  });

  it("handles table separator rows and table rows", () => {
    const input = "| Name | Age |\n|------|-----|\n| Alice | 30 |";
    const result = markdownToPlainText(input);
    expect(result).not.toContain("|------|");
    expect(result).toContain("Alice");
  });
});

// ---------------------------------------------------------------------------
// contextTokenStore
// ---------------------------------------------------------------------------

describe("contextTokenStore", () => {
  beforeEach(() => {
    contextTokenStore.clear();
  });

  it("set then get returns the same value", () => {
    setContextToken("peer_1", "token_abc");
    expect(getContextToken("peer_1")).toBe("token_abc");
  });

  it("returns undefined for unknown peerId", () => {
    expect(getContextToken("nonexistent")).toBeUndefined();
  });

  it("updates existing entry", () => {
    setContextToken("peer_2", "old_token");
    setContextToken("peer_2", "new_token");
    expect(getContextToken("peer_2")).toBe("new_token");
  });
});
