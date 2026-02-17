import { describe, expect, it } from "vitest";
import { sanitizePromptLiteral } from "./prompt-literal";

describe("sanitizePromptLiteral", () => {
  it("strips control characters", () => {
    expect(sanitizePromptLiteral("/tmp/a\nb\rc\x00d\te")).toBe("/tmp/abcde");
  });

  it("strips unicode separators and bidi format chars", () => {
    expect(sanitizePromptLiteral(`/tmp/a\u2028b\u2029c\u202Ed`)).toBe("/tmp/abcd");
  });

  it("keeps normal visible characters", () => {
    expect(sanitizePromptLiteral("你好 Luka /workspace-01")).toBe("你好 Luka /workspace-01");
  });
});
