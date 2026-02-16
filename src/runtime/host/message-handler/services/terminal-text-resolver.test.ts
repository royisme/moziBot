import { describe, expect, it } from "vitest";
import { resolveTerminalReplyDecision, resolveTerminalReplyText } from "./terminal-text-resolver";

describe("resolveTerminalReplyText", () => {
  it("returns undefined when both inputs are empty", () => {
    expect(resolveTerminalReplyText({})).toBeUndefined();
    expect(resolveTerminalReplyText({ finalReplyText: "  ", streamedReplyText: "\n\n" })).toBe(
      undefined,
    );
  });

  it("uses final text when only final exists", () => {
    expect(resolveTerminalReplyText({ finalReplyText: "final" })).toBe("final");
  });

  it("uses streamed text when only streamed exists", () => {
    expect(resolveTerminalReplyText({ streamedReplyText: "streamed" })).toBe("streamed");
  });

  it("prefers final text over streamed text when both exist", () => {
    expect(
      resolveTerminalReplyText({
        finalReplyText: "最终完整回复",
        streamedReplyText: "部分流式回复",
      }),
    ).toBe("最终完整回复");
  });

  it("returns detailed source and char metrics for observability", () => {
    const decision = resolveTerminalReplyDecision({
      finalReplyText: "你好！我是 pi 中的一个编码助手，可以帮你处理代码和命令。",
      streamedReplyText: "你好！我是 pi 中的",
    });

    expect(decision.source).toBe("final_over_streamed");
    expect(decision.finalChars).toBe(
      "你好！我是 pi 中的一个编码助手，可以帮你处理代码和命令。".length,
    );
    expect(decision.streamedChars).toBe("你好！我是 pi 中的".length);
    expect(decision.text).toBe("你好！我是 pi 中的一个编码助手，可以帮你处理代码和命令。");
  });
});
