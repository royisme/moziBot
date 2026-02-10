import { describe, expect, it } from "vitest";
import { planOutboundByNegotiation } from "./outbound";

describe("multimodal outbound planning", () => {
  it("keeps text output when text modality allowed", () => {
    const outbound = planOutboundByNegotiation({
      channelId: "telegram",
      text: "hello",
      inboundPlan: {
        acceptedInput: [],
        providerInput: [],
        outputModalities: ["text"],
        transforms: [],
        fallbackUsed: false,
      },
    });
    expect(outbound.text).toBe("hello");
  });

  it("returns fallback message when text output not allowed", () => {
    const outbound = planOutboundByNegotiation({
      channelId: "discord",
      text: "hello",
      inboundPlan: {
        acceptedInput: [],
        providerInput: [],
        outputModalities: ["audio"],
        transforms: [],
        fallbackUsed: false,
      },
    });
    expect(outbound.text).toContain("does not support text output");
  });
});
