import { describe, expect, it } from "vitest";
import { resolveLastAssistantReplyText } from "./reply-finalizer";

describe("resolveLastAssistantReplyText", () => {
  const renderOptions = {
    showThinking: false,
    showToolCalls: "off" as const,
  };

  it("returns undefined for tool-use terminal assistant message", () => {
    const reply = resolveLastAssistantReplyText({
      messages: [
        {
          role: "assistant",
          stopReason: "toolUse",
          content: [
            {
              type: "text",
              text: "在当前工作目录 `/` 下让我先查一下。",
            },
            {
              type: "toolCall",
              name: "find",
              arguments: { path: "/", pattern: "**/openclaw*" },
            },
          ],
        },
      ],
      renderOptions,
    });

    expect(reply).toBeUndefined();
  });

  it("returns rendered text for normal terminal assistant message", () => {
    const reply = resolveLastAssistantReplyText({
      messages: [
        {
          role: "assistant",
          stopReason: "stop",
          content: [{ type: "text", text: "我可以看到 `.extLibs/openclaw`。" }],
        },
      ],
      renderOptions,
    });

    expect(reply).toBe("我可以看到 `.extLibs/openclaw`。");
  });
});
