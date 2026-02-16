import { describe, expect, it, vi } from "vitest";
import { buildReplyOutbound, dispatchReply } from "./reply-dispatcher";

describe("reply-dispatcher", () => {
  it("redacts leaked reasoning preamble by default for external channels", () => {
    const outbound = buildReplyOutbound({
      channelId: "telegram",
      replyText: "Reasoning:\n用户问好。\n\n你好！有什么我可以帮你的吗？",
      inboundPlan: null,
    });

    expect(outbound.text).toBe("你好！有什么我可以帮你的吗？");
    expect(outbound.text).not.toContain("Reasoning:");
  });

  it("redacts think-tag content by default for external channels", () => {
    const outbound = buildReplyOutbound({
      channelId: "telegram",
      replyText: "<think>internal</think>visible",
      inboundPlan: null,
    });

    expect(outbound.text).toBe("visible");
    expect(outbound.text).not.toContain("internal");
    expect(outbound.text).not.toContain("<think>");
  });

  it("preserves thinking only for localDesktop with showThinking enabled", () => {
    const outbound = buildReplyOutbound({
      channelId: "localDesktop",
      replyText: "Reasoning:\nstep\n\nanswer",
      inboundPlan: null,
      showThinking: true,
    });

    expect(outbound.text).toContain("Reasoning:");
    expect(outbound.text).toContain("answer");
  });

  it("dispatchReply applies redaction guard before send", async () => {
    const send = vi.fn(async () => "out-1");

    await dispatchReply({
      channel: { id: "telegram", send },
      peerId: "chat-1",
      channelId: "telegram",
      replyText: "<think>hidden</think>hello",
      inboundPlan: null,
      traceId: "trace-1",
    });

    expect(send).toHaveBeenCalledTimes(1);
    const firstCall = send.mock.calls[0] as unknown[] | undefined;
    expect(firstCall).toBeDefined();
    const payload = (firstCall && firstCall.length > 1 ? firstCall[1] : {}) as {
      text?: string;
      traceId?: string;
    };
    expect(payload.text).toBe("hello");
    expect(payload.traceId).toBe("trace-1");
  });
});
