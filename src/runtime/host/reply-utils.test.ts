import { describe, expect, it } from "vitest";
import {
  extractAssistantText,
  getAssistantFailureReason,
  isSilentReplyText,
  renderAssistantReply,
  SILENT_REPLY_TOKEN,
} from "./reply-utils";

describe("reply-utils", () => {
  describe("isSilentReplyText", () => {
    it("matches exact silent token", () => {
      expect(isSilentReplyText(SILENT_REPLY_TOKEN)).toBe(true);
      expect(isSilentReplyText(` ${SILENT_REPLY_TOKEN} `)).toBe(true);
    });

    it("matches prefix/suffix token", () => {
      expect(isSilentReplyText(`${SILENT_REPLY_TOKEN} -- already sent`)).toBe(true);
      expect(isSilentReplyText(`done. ${SILENT_REPLY_TOKEN}`)).toBe(true);
    });

    it("does not match unrelated text", () => {
      expect(isSilentReplyText("NO_REPLYING")).toBe(false);
      expect(isSilentReplyText("normal response")).toBe(false);
      expect(isSilentReplyText("")).toBe(false);
    });
  });

  describe("extractAssistantText", () => {
    it("extracts text from string", () => {
      expect(extractAssistantText("hello")).toBe("hello");
    });

    it("extracts text from text and output_text parts", () => {
      const content = [
        { type: "output_text", text: "A" },
        { type: "text", text: "B" },
      ];
      expect(extractAssistantText(content)).toBe("AB");
    });

    it("strips think tags from text", () => {
      const content = "<think>hidden</think> shown";
      expect(extractAssistantText(content)).toBe("shown");
    });

    it("extracts text from nested content", () => {
      const content = { content: [{ output_text: "X" }, { text: "Y" }] };
      expect(extractAssistantText(content)).toBe("XY");
    });
  });

  describe("renderAssistantReply", () => {
    it("hides thinking and tool calls by default", () => {
      const content = [
        { type: "thinking", thinking: "internal" },
        { type: "text", text: "visible" },
        { type: "toolCall", name: "exec", arguments: { command: "pwd" } },
      ];
      expect(renderAssistantReply(content)).toBe("visible");
    });

    it("renders reasoning when enabled", () => {
      const content = [
        { type: "thinking", thinking: "step-1" },
        { type: "text", text: "answer" },
      ];
      expect(renderAssistantReply(content, { showThinking: true })).toBe(
        "Reasoning:\nstep-1\n\nanswer",
      );
    });

    it("renders tool call summary when enabled", () => {
      const content = [
        { type: "text", text: "done" },
        { type: "toolCall", name: "exec", arguments: { command: "ls", cwd: "/tmp" } },
      ];
      expect(renderAssistantReply(content, { showToolCalls: "summary" })).toContain("Tool calls:");
    });

    it("strips leaked reasoning preamble by default", () => {
      const content =
        "Reasoning:\n用户问现在几点了。\n\n现在是 2026年2月15日 星期日 凌晨12:14:52（美国东部标准时间 EST）。";
      expect(renderAssistantReply(content)).toBe(
        "现在是 2026年2月15日 星期日 凌晨12:14:52（美国东部标准时间 EST）。",
      );
    });

    it("keeps reasoning preamble when showThinking is enabled", () => {
      const content = "Reasoning:\nstep\n\nanswer";
      expect(renderAssistantReply(content, { showThinking: true })).toBe("Reasoning:\nstep\n\nanswer");
    });
  });

  describe("getAssistantFailureReason", () => {
    it("returns errorMessage when present", () => {
      const reason = getAssistantFailureReason({ stopReason: "error", errorMessage: "404 failed" });
      expect(reason).toBe("404 failed");
    });

    it("returns fallback reason on stopReason error", () => {
      const reason = getAssistantFailureReason({ stopReason: "error" });
      expect(reason).toBe("assistant returned stopReason=error");
    });

    it("returns null when no failure", () => {
      const reason = getAssistantFailureReason({ stopReason: "stop", errorMessage: "" });
      expect(reason).toBeNull();
    });
  });
});
