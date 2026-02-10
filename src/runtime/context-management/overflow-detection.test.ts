import { describe, expect, it } from "vitest";
import {
  isCompactionFailureError,
  isContextOverflowError,
  isLikelyContextOverflowError,
} from "./overflow-detection";

describe("isContextOverflowError", () => {
  it("returns true for 'request_too_large'", () => {
    expect(isContextOverflowError("request_too_large")).toBe(true);
    expect(isContextOverflowError("Error: request_too_large occurred")).toBe(true);
  });

  it("returns true for 'request size exceeds model context window'", () => {
    expect(isContextOverflowError("request size exceeds model context window")).toBe(true);
    expect(isContextOverflowError("The request size exceeds the model context window limit")).toBe(
      true,
    );
  });

  it("returns true for 'request size exceeds' + 'context length'", () => {
    expect(isContextOverflowError("request size exceeds the maximum context length")).toBe(true);
  });

  it("returns true for 'context length exceeded'", () => {
    expect(isContextOverflowError("context length exceeded")).toBe(true);
    expect(isContextOverflowError("Error: context length exceeded")).toBe(true);
  });

  it("returns true for 'maximum context length'", () => {
    expect(isContextOverflowError("maximum context length")).toBe(true);
    expect(isContextOverflowError("exceeds maximum context length")).toBe(true);
  });

  it("returns true for 'prompt is too long'", () => {
    expect(isContextOverflowError("prompt is too long")).toBe(true);
    expect(isContextOverflowError("The prompt is too long for the model")).toBe(true);
  });

  it("returns true for 'exceeds model context window'", () => {
    expect(isContextOverflowError("exceeds model context window")).toBe(true);
    expect(isContextOverflowError("Input exceeds model context window")).toBe(true);
  });

  it("returns true for '413 too large' pattern", () => {
    expect(isContextOverflowError("413 too large")).toBe(true);
    expect(isContextOverflowError("HTTP 413: too large")).toBe(true);
  });

  it("returns true for 'context overflow'", () => {
    expect(isContextOverflowError("context overflow")).toBe(true);
    expect(isContextOverflowError("Error: context overflow detected")).toBe(true);
  });

  it("returns true for 'request exceeds the maximum size'", () => {
    expect(isContextOverflowError("request exceeds the maximum size")).toBe(true);
  });

  it("returns false for empty/undefined input", () => {
    expect(isContextOverflowError("")).toBe(false);
    expect(isContextOverflowError(undefined)).toBe(false);
  });

  it("returns false for generic errors like 'network timeout'", () => {
    expect(isContextOverflowError("network timeout")).toBe(false);
    expect(isContextOverflowError("connection refused")).toBe(false);
    expect(isContextOverflowError("internal server error")).toBe(false);
    expect(isContextOverflowError("rate limit exceeded")).toBe(false);
  });

  it("returns false for 'context window too small'", () => {
    expect(isContextOverflowError("context window too small")).toBe(false);
    expect(isContextOverflowError("the context window minimum is 4000")).toBe(false);
  });
});

describe("isLikelyContextOverflowError", () => {
  it("returns true for all isContextOverflowError cases", () => {
    expect(isLikelyContextOverflowError("request_too_large")).toBe(true);
    expect(isLikelyContextOverflowError("context length exceeded")).toBe(true);
    expect(isLikelyContextOverflowError("prompt is too long")).toBe(true);
    expect(isLikelyContextOverflowError("413 too large")).toBe(true);
  });

  it("returns true for heuristic matches like 'context window limit exceeded'", () => {
    expect(isLikelyContextOverflowError("context window limit exceeded")).toBe(true);
    expect(isLikelyContextOverflowError("the context window is too long")).toBe(true);
    expect(isLikelyContextOverflowError("context window requested")).toBe(true);
    expect(isLikelyContextOverflowError("prompt too large")).toBe(true);
    expect(isLikelyContextOverflowError("request exceeds limit")).toBe(true);
    expect(isLikelyContextOverflowError("input too long")).toBe(true);
  });

  it("returns false for 'context window too small' or 'minimum is'", () => {
    expect(isLikelyContextOverflowError("context window too small")).toBe(false);
    expect(isLikelyContextOverflowError("the minimum is 4000 tokens")).toBe(false);
    expect(isLikelyContextOverflowError("context window too small, minimum is 1000")).toBe(false);
  });

  it("returns false for empty/undefined", () => {
    expect(isLikelyContextOverflowError("")).toBe(false);
    expect(isLikelyContextOverflowError(undefined)).toBe(false);
  });

  it("returns false for unrelated errors", () => {
    expect(isLikelyContextOverflowError("billing error")).toBe(false);
    expect(isLikelyContextOverflowError("authentication failed")).toBe(false);
  });
});

describe("isCompactionFailureError", () => {
  it("returns true for overflow + 'compaction failed'", () => {
    expect(
      isCompactionFailureError("request_too_large: compaction failed after auto-compaction"),
    ).toBe(true);
    expect(isCompactionFailureError("context length exceeded and compaction failed")).toBe(true);
  });

  it("returns true for overflow + 'summarization failed'", () => {
    expect(isCompactionFailureError("prompt is too long: summarization failed")).toBe(true);
    expect(isCompactionFailureError("context overflow: summarization failed")).toBe(true);
  });

  it("returns true for overflow + 'auto-compaction'", () => {
    expect(isCompactionFailureError("request_too_large during auto-compaction")).toBe(true);
  });

  it("returns true for overflow + 'compaction'", () => {
    expect(isCompactionFailureError("context overflow during compaction")).toBe(true);
    expect(isCompactionFailureError("compaction failed: context length exceeded")).toBe(true);
  });

  it("returns false for non-overflow errors", () => {
    expect(isCompactionFailureError("network timeout")).toBe(false);
    expect(isCompactionFailureError("rate limit exceeded")).toBe(false);
    expect(isCompactionFailureError("billing error")).toBe(false);
  });

  it("returns false for overflow without compaction keywords", () => {
    expect(isCompactionFailureError("request_too_large")).toBe(false);
    expect(isCompactionFailureError("context length exceeded")).toBe(false);
    expect(isCompactionFailureError("prompt is too long")).toBe(false);
  });

  it("returns false for empty/undefined", () => {
    expect(isCompactionFailureError("")).toBe(false);
    expect(isCompactionFailureError(undefined)).toBe(false);
  });
});
