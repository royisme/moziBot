import { describe, expect, it } from "vitest";
import {
  CONTEXT_WINDOW_HARD_MIN_TOKENS,
  CONTEXT_WINDOW_WARN_BELOW_TOKENS,
  evaluateContextWindowGuard,
  resolveContextWindowInfo,
  type ContextWindowInfo,
} from "./context-window-guard";

describe("resolveContextWindowInfo", () => {
  it("uses modelContextWindow when no config override", () => {
    const result = resolveContextWindowInfo({ modelContextWindow: 128_000 });
    expect(result.tokens).toBe(128_000);
    expect(result.source).toBe("model");
  });

  it("uses configContextTokens as cap (takes minimum)", () => {
    const result = resolveContextWindowInfo({
      modelContextWindow: 128_000,
      configContextTokens: 64_000,
    });
    expect(result.tokens).toBe(64_000);
    expect(result.source).toBe("config");
  });

  it("does not cap when config is higher than model", () => {
    const result = resolveContextWindowInfo({
      modelContextWindow: 128_000,
      configContextTokens: 200_000,
    });
    expect(result.tokens).toBe(128_000);
    expect(result.source).toBe("model");
  });

  it("falls back to defaultTokens when no model or config", () => {
    const result = resolveContextWindowInfo({ defaultTokens: 100_000 });
    expect(result.tokens).toBe(100_000);
    expect(result.source).toBe("default");
  });

  it("uses default (200_000) when nothing provided", () => {
    const result = resolveContextWindowInfo({});
    expect(result.tokens).toBe(200_000);
    expect(result.source).toBe("default");
  });

  it("source is 'model' when using model value", () => {
    const result = resolveContextWindowInfo({ modelContextWindow: 64_000 });
    expect(result.source).toBe("model");
  });

  it("source is 'config' when config cap is lower", () => {
    const result = resolveContextWindowInfo({
      modelContextWindow: 128_000,
      configContextTokens: 32_000,
    });
    expect(result.source).toBe("config");
  });

  it("source is 'default' when neither is provided", () => {
    const result = resolveContextWindowInfo({});
    expect(result.source).toBe("default");
  });

  it("ignores non-positive values", () => {
    const result = resolveContextWindowInfo({
      modelContextWindow: -1000,
      configContextTokens: 0,
      defaultTokens: -500,
    });
    expect(result.tokens).toBe(200_000); // Falls to default
    expect(result.source).toBe("default");
  });

  it("ignores non-finite values", () => {
    const result = resolveContextWindowInfo({
      modelContextWindow: Number.NaN,
      configContextTokens: Number.POSITIVE_INFINITY,
    });
    expect(result.tokens).toBe(200_000); // Falls to default
    expect(result.source).toBe("default");
  });

  it("ignores undefined values", () => {
    const result = resolveContextWindowInfo({
      modelContextWindow: undefined,
      configContextTokens: undefined,
    });
    expect(result.tokens).toBe(200_000);
    expect(result.source).toBe("default");
  });
});

describe("evaluateContextWindowGuard", () => {
  it("shouldBlock = true when tokens < 16_000", () => {
    const info: ContextWindowInfo = { tokens: 8_000, source: "model" };
    const result = evaluateContextWindowGuard({ info });
    expect(result.shouldBlock).toBe(true);
    expect(result.shouldWarn).toBe(false);
  });

  it("shouldBlock = false when tokens >= 16_000", () => {
    const info: ContextWindowInfo = { tokens: 16_000, source: "model" };
    const result = evaluateContextWindowGuard({ info });
    expect(result.shouldBlock).toBe(false);
  });

  it("shouldWarn = true when tokens >= 16_000 and < 32_000", () => {
    const info: ContextWindowInfo = { tokens: 24_000, source: "model" };
    const result = evaluateContextWindowGuard({ info });
    expect(result.shouldBlock).toBe(false);
    expect(result.shouldWarn).toBe(true);
  });

  it("shouldWarn = false when tokens >= 32_000", () => {
    const info: ContextWindowInfo = { tokens: 32_000, source: "model" };
    const result = evaluateContextWindowGuard({ info });
    expect(result.shouldBlock).toBe(false);
    expect(result.shouldWarn).toBe(false);
  });

  it("shouldWarn = false when tokens > 32_000", () => {
    const info: ContextWindowInfo = { tokens: 128_000, source: "model" };
    const result = evaluateContextWindowGuard({ info });
    expect(result.shouldBlock).toBe(false);
    expect(result.shouldWarn).toBe(false);
  });

  it("message is set when shouldBlock", () => {
    const info: ContextWindowInfo = { tokens: 8_000, source: "model" };
    const result = evaluateContextWindowGuard({ info });
    expect(result.message).toContain("below minimum");
    expect(result.message).toContain("8000");
    expect(result.message).toContain(String(CONTEXT_WINDOW_HARD_MIN_TOKENS));
  });

  it("message is set when shouldWarn", () => {
    const info: ContextWindowInfo = { tokens: 24_000, source: "model" };
    const result = evaluateContextWindowGuard({ info });
    expect(result.message).toContain("below recommended");
    expect(result.message).toContain("24000");
    expect(result.message).toContain(String(CONTEXT_WINDOW_WARN_BELOW_TOKENS));
  });

  it("message is undefined when no warning or block", () => {
    const info: ContextWindowInfo = { tokens: 128_000, source: "model" };
    const result = evaluateContextWindowGuard({ info });
    expect(result.message).toBeUndefined();
  });

  it("custom thresholds are respected", () => {
    const info: ContextWindowInfo = { tokens: 5_000, source: "model" };
    const result = evaluateContextWindowGuard({
      info,
      hardMinTokens: 10_000,
      warnBelowTokens: 20_000,
    });
    expect(result.shouldBlock).toBe(true);
    expect(result.shouldWarn).toBe(false);
  });

  it("custom thresholds with warn only", () => {
    const info: ContextWindowInfo = { tokens: 15_000, source: "model" };
    const result = evaluateContextWindowGuard({
      info,
      hardMinTokens: 10_000,
      warnBelowTokens: 20_000,
    });
    expect(result.shouldBlock).toBe(false);
    expect(result.shouldWarn).toBe(true);
  });

  it("both false for zero tokens", () => {
    const info: ContextWindowInfo = { tokens: 0, source: "model" };
    const result = evaluateContextWindowGuard({ info });
    expect(result.shouldBlock).toBe(false);
    expect(result.shouldWarn).toBe(false);
  });

  it("preserves source in result", () => {
    const info: ContextWindowInfo = { tokens: 24_000, source: "config" };
    const result = evaluateContextWindowGuard({ info });
    expect(result.source).toBe("config");
  });

  it("uses constant defaults when no thresholds provided", () => {
    const info: ContextWindowInfo = { tokens: 20_000, source: "model" };
    const result = evaluateContextWindowGuard({ info });
    expect(result.shouldBlock).toBe(false); // >= 16_000
    expect(result.shouldWarn).toBe(true); // < 32_000
  });
});
