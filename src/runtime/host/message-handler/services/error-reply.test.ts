import { describe, expect, it } from "vitest";
import { createErrorReplyText } from "./error-reply";

describe("createErrorReplyText", () => {
  it("returns actionable guidance for missing auth secrets", () => {
    expect(createErrorReplyText(new Error("AUTH_MISSING OPENAI_API_KEY"))).toBe(
      "Missing authentication secret OPENAI_API_KEY. Set it with /setAuth set OPENAI_API_KEY=<value> [--scope=agent|global].",
    );
  });

  it("returns provider/auth unavailable guidance for invalid credentials", () => {
    expect(createErrorReplyText(new Error("Unauthorized: invalid api key"))).toBe(
      "Model provider is unavailable or not configured for this turn. Check provider/runtime configuration and try again. Details: Unauthorized: invalid api key",
    );
  });

  it("returns timeout-specific guidance for timeout errors", () => {
    expect(createErrorReplyText(new Error("Agent prompt timed out"))).toBe(
      "The model timed out for this turn. Try again, switch to a faster model, or check provider responsiveness. Details: Agent prompt timed out",
    );
  });

  it("falls back to generic guidance for execution failures", () => {
    expect(createErrorReplyText(new Error("boom"))).toBe(
      "Sorry, an error occurred while processing the message: boom",
    );
  });
});
