import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import {
  extractFromTurn,
  extractFromMessages,
  containsSecret,
  renderMessageText,
  MemoryExtractionService,
} from "./extraction-service";
import { MemoryInboxStore } from "./inbox-store";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeUserMsg(content: string): AgentMessage {
  return { role: "user", content } as AgentMessage;
}

function makeAssistantMsg(content: string): AgentMessage {
  return { role: "assistant", content } as unknown as AgentMessage;
}

// ---------------------------------------------------------------------------
// containsSecret
// ---------------------------------------------------------------------------

describe("containsSecret", () => {
  it("returns false for normal text", () => {
    expect(containsSecret("prefer dark mode")).toBe(false);
  });

  it("detects OpenAI-style keys", () => {
    expect(containsSecret("use sk-ABCDEFGHIJKLMNOPQRSTUVWX")).toBe(true);
  });

  it("detects Telegram bot tokens", () => {
    expect(containsSecret("bot12345678:ABCDEFGHIJKLMNOPQRSTUVWXYZabc")).toBe(true);
  });

  it("detects Bearer tokens", () => {
    expect(containsSecret("Authorization: Bearer ABCDEFGHIJKLMNOPQRSTUVWX")).toBe(true);
  });

  it("detects Tavily-style keys", () => {
    expect(containsSecret("tvly-ABCDEFGHIJKLMNOPQRSTUVWX")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// renderMessageText
// ---------------------------------------------------------------------------

describe("renderMessageText", () => {
  it("returns a string as-is", () => {
    expect(renderMessageText("hello")).toBe("hello");
  });

  it("joins text content blocks", () => {
    expect(renderMessageText([{ type: "text", text: "hello" }, { type: "text", text: " world" }])).toBe("hello world");
  });

  it("returns empty string for non-array non-string", () => {
    expect(renderMessageText(42)).toBe("");
    expect(renderMessageText(null)).toBe("");
  });

  it("ignores non-text parts", () => {
    expect(renderMessageText([{ type: "image" }, { type: "text", text: "hi" }])).toBe("hi");
  });
});

// ---------------------------------------------------------------------------
// extractFromTurn
// ---------------------------------------------------------------------------

describe("extractFromTurn", () => {
  it("returns empty array when both userText and replyText are absent", () => {
    const result = extractFromTurn({ agentId: "mozi" });
    expect(result).toHaveLength(0);
  });

  it("returns empty array when both texts are empty/whitespace", () => {
    const result = extractFromTurn({ userText: "   ", replyText: "", agentId: "mozi" });
    expect(result).toHaveLength(0);
  });

  it("produces one candidate with combined User+Assistant summary", () => {
    const result = extractFromTurn({
      userText: "what is pnpm",
      replyText: "pnpm is a fast package manager",
      agentId: "mozi",
    });
    expect(result).toHaveLength(1);
    expect(result[0]!.summary).toContain("User: what is pnpm");
    expect(result[0]!.summary).toContain("Assistant: pnpm is a fast package manager");
  });

  it("omits a field if it contains a secret", () => {
    const result = extractFromTurn({
      userText: "my key is sk-ABCDEFGHIJKLMNOPQRSTUVWX",
      replyText: "noted",
      agentId: "mozi",
    });
    // Secret in userText → only assistant line survives
    expect(result).toHaveLength(1);
    expect(result[0]!.summary).not.toContain("sk-");
    expect(result[0]!.summary).toContain("Assistant: noted");
  });

  it("returns empty array when only a command is present", () => {
    const result = extractFromTurn({ userText: "/reset", agentId: "mozi" });
    expect(result).toHaveLength(0);
  });

  it("clips long text to MAX_LINE_CHARS", () => {
    const long = "x".repeat(300);
    const result = extractFromTurn({ userText: long, agentId: "mozi" });
    expect(result[0]!.summary).toContain("...");
    // Total length of the clipped value is 240 chars + "..."
    expect(result[0]!.summary.length).toBeLessThan(320);
  });

  it("sets source to turn_completed", () => {
    const result = extractFromTurn({ userText: "hello", agentId: "mozi" });
    expect(result[0]!.source).toBe("turn_completed");
  });

  it("sets agentId correctly", () => {
    const result = extractFromTurn({ userText: "hello", agentId: "my-agent" });
    expect(result[0]!.agentId).toBe("my-agent");
  });

  it("sets status to pending", () => {
    const result = extractFromTurn({ userText: "hello", agentId: "mozi" });
    expect(result[0]!.status).toBe("pending");
  });

  it("has valid id and dedupeKey", () => {
    const result = extractFromTurn({ userText: "hello", agentId: "mozi" });
    expect(result[0]!.id).toBeTruthy();
    expect(result[0]!.dedupeKey).toBeTruthy();
  });

  it("same content on same day produces same id (idempotent)", () => {
    const ts = "2024-06-01T10:00:00Z";
    const r1 = extractFromTurn({ userText: "hello", agentId: "mozi", ts });
    const r2 = extractFromTurn({ userText: "hello", agentId: "mozi", ts });
    expect(r1[0]!.id).toBe(r2[0]!.id);
  });
});

// ---------------------------------------------------------------------------
// extractFromMessages
// ---------------------------------------------------------------------------

describe("extractFromMessages", () => {
  it("returns empty array for undefined messages", () => {
    const result = extractFromMessages({
      messages: undefined,
      source: "before_reset",
      agentId: "mozi",
    });
    expect(result).toHaveLength(0);
  });

  it("returns empty array for empty messages", () => {
    const result = extractFromMessages({
      messages: [],
      source: "before_reset",
      agentId: "mozi",
    });
    expect(result).toHaveLength(0);
  });

  it("pairs user+assistant messages into exchange summaries", () => {
    const messages = [makeUserMsg("ship feature A"), makeAssistantMsg("decision captured")];
    const result = extractFromMessages({
      messages,
      source: "before_reset",
      agentId: "mozi",
    });
    expect(result).toHaveLength(1);
    expect(result[0]!.summary).toContain("User: ship feature A");
    expect(result[0]!.summary).toContain("Assistant: decision captured");
  });

  it("handles unpaired final user message", () => {
    const messages = [
      makeUserMsg("question one"),
      makeAssistantMsg("answer one"),
      makeUserMsg("question two"),
    ];
    const result = extractFromMessages({
      messages,
      source: "before_reset",
      agentId: "mozi",
    });
    expect(result).toHaveLength(2);
    expect(result[1]!.summary).toContain("User: question two");
  });

  it("filters out command messages (starting with /)", () => {
    const messages = [makeUserMsg("/reset"), makeAssistantMsg("session reset")];
    const result = extractFromMessages({
      messages,
      source: "before_reset",
      agentId: "mozi",
    });
    // /reset line filtered → only assistant line remains as unpaired candidate
    expect(result).toHaveLength(1);
    expect(result[0]!.summary).toContain("Assistant: session reset");
  });

  it("filters out secret-containing messages", () => {
    const messages = [
      makeUserMsg("my key sk-ABCDEFGHIJKLMNOPQRSTUVWX is secret"),
      makeAssistantMsg("got it"),
    ];
    const result = extractFromMessages({
      messages,
      source: "before_reset",
      agentId: "mozi",
    });
    expect(result).toHaveLength(1);
    expect(result[0]!.summary).not.toContain("sk-");
  });

  it("respects maxMessages limit", () => {
    const messages = Array.from({ length: 20 }, (_, i) =>
      i % 2 === 0 ? makeUserMsg(`q${i}`) : makeAssistantMsg(`a${i}`),
    );
    const result = extractFromMessages({
      messages,
      source: "before_reset",
      agentId: "mozi",
      maxMessages: 4,
    });
    // 4 messages → 2 pairs → 2 candidates
    expect(result.length).toBeLessThanOrEqual(2);
  });

  it("sets source correctly", () => {
    const result = extractFromMessages({
      messages: [makeUserMsg("hello")],
      source: "before_reset",
      agentId: "mozi",
    });
    expect(result[0]!.source).toBe("before_reset");
  });

  it("handles content-block arrays in AgentMessage", () => {
    const msg: AgentMessage = {
      role: "user",
      content: [{ type: "text", text: "use pnpm not npm" }],
    } as unknown as AgentMessage;
    const result = extractFromMessages({
      messages: [msg],
      source: "before_reset",
      agentId: "mozi",
    });
    expect(result[0]!.summary).toContain("use pnpm not npm");
  });
});

// ---------------------------------------------------------------------------
// MemoryExtractionService – file I/O integration
// ---------------------------------------------------------------------------

describe("MemoryExtractionService", () => {
  let tmpDir: string;
  let store: MemoryInboxStore;
  let service: MemoryExtractionService;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "extraction-service-test-"));
    store = new MemoryInboxStore(tmpDir);
    await store.init();
    service = new MemoryExtractionService(store);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  describe("extractFromTurnAndSubmit", () => {
    it("writes candidates to inbox for a valid turn", async () => {
      const result = await service.extractFromTurnAndSubmit({
        userText: "prefer dark mode",
        replyText: "noted your preference",
        agentId: "mozi",
        ts: "2024-06-01T10:00:00Z",
      });

      expect(result.written).toBe(1);
      expect(result.candidates).toHaveLength(1);

      const shard = await store.readShard("2024-06-01");
      expect(shard).toHaveLength(1);
      expect(shard[0]!.summary).toContain("User: prefer dark mode");
    });

    it("returns written=0 and empty candidates for empty turn", async () => {
      const result = await service.extractFromTurnAndSubmit({
        agentId: "mozi",
        ts: "2024-06-01T10:00:00Z",
      });

      expect(result.written).toBe(0);
      expect(result.candidates).toHaveLength(0);
    });

    it("is idempotent – submitting same turn twice does not duplicate", async () => {
      const params = {
        userText: "prefer tabs over spaces",
        replyText: "understood",
        agentId: "mozi",
        ts: "2024-06-01T10:00:00Z",
      };

      await service.extractFromTurnAndSubmit(params);
      await service.extractFromTurnAndSubmit(params);

      const shard = await store.readShard("2024-06-01");
      expect(shard).toHaveLength(1);
    });

    it("writes candidate with status=pending", async () => {
      await service.extractFromTurnAndSubmit({
        userText: "hello world",
        agentId: "mozi",
        ts: "2024-06-01T10:00:00Z",
      });

      const shard = await store.readShard("2024-06-01");
      expect(shard[0]!.status).toBe("pending");
    });
  });

  describe("extractFromMessagesAndSubmit", () => {
    it("writes candidates to inbox for message array", async () => {
      const messages: AgentMessage[] = [
        makeUserMsg("we decided to use bun"),
        makeAssistantMsg("decision recorded"),
      ];

      const result = await service.extractFromMessagesAndSubmit({
        messages,
        source: "before_reset",
        agentId: "mozi",
        ts: "2024-06-01T12:00:00Z",
      });

      expect(result.written).toBe(1);

      const shard = await store.readShard("2024-06-01");
      expect(shard).toHaveLength(1);
      expect(shard[0]!.source).toBe("before_reset");
    });

    it("returns written=0 for empty messages", async () => {
      const result = await service.extractFromMessagesAndSubmit({
        messages: [],
        source: "before_reset",
        agentId: "mozi",
        ts: "2024-06-01T12:00:00Z",
      });

      expect(result.written).toBe(0);
    });

    it("handles inbox write failure gracefully", async () => {
      // Corrupt the store by making appendMany throw
      vi.spyOn(store, "appendMany").mockRejectedValueOnce(new Error("disk full"));

      const result = await service.extractFromMessagesAndSubmit({
        messages: [makeUserMsg("hello")],
        source: "before_reset",
        agentId: "mozi",
        ts: "2024-06-01T12:00:00Z",
      });

      // Should not throw – returns written=0
      expect(result.written).toBe(0);
      expect(result.candidates).toHaveLength(1);
    });
  });
});
