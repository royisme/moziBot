import { describe, expect, it } from "vitest";
import type { InboundMessage } from "../../../adapters/channels/types";
import { buildPromptText } from "./prompt-text";

const baseMessage: InboundMessage = {
  id: "m1",
  channel: "telegram",
  peerId: "p1",
  peerType: "dm",
  senderId: "u1",
  timestamp: new Date(),
  text: "hello",
  raw: {},
};

describe("buildPromptText", () => {
  it("does not expand attached media into pseudo-vision text", () => {
    const text = buildPromptText({
      message: baseMessage,
      rawText: "describe",
      ingestPlan: {
        acceptedInput: [],
        providerInput: [
          {
            id: "p1",
            role: "user",
            index: 0,
            modality: "image",
            media: {
              mediaId: "img-1",
              mimeType: "image/png",
              byteSize: 4,
              sha256: "sha",
            },
          },
        ],
        outputModalities: ["text"],
        transforms: [],
        fallbackUsed: false,
      },
    });

    expect(text).toContain("fallback/debug only");
    expect(text).not.toContain("[media#1]");
  });
});
