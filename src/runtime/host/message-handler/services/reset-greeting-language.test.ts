import { describe, expect, it } from "vitest";
import {
  extractIdentityLanguageHintFromSystemPrompt,
  normalizeIdentityLanguageHint,
  selectNewSessionFallbackText,
} from "./reset-greeting-language";

describe("reset greeting language helpers", () => {
  it("normalizes common language hints", () => {
    expect(normalizeIdentityLanguageHint("zh-CN")).toBe("zh-CN");
    expect(normalizeIdentityLanguageHint("ZH_hans")).toBe("zh-CN");
    expect(normalizeIdentityLanguageHint("en-US")).toBe("en");
    expect(normalizeIdentityLanguageHint("")).toBeNull();
  });

  it("extracts language hint from identity section field", () => {
    const prompt = `
# Identity & Persona
## USER.md
Language preference: zh-CN
`;
    expect(extractIdentityLanguageHintFromSystemPrompt(prompt)).toBe("zh-CN");
  });

  it("extracts language hint from chinese preference wording", () => {
    const prompt = `
# Identity & Persona
## SOUL.md
默认使用简体中文回复
`;
    expect(extractIdentityLanguageHintFromSystemPrompt(prompt)).toBe("zh-CN");
  });

  it("selects localized fallback text by language hint", () => {
    expect(selectNewSessionFallbackText("zh-CN")).toContain("新会话已开始");
    expect(selectNewSessionFallbackText("en")).toContain("New session started");
    expect(selectNewSessionFallbackText(null)).toContain("New session started");
  });
});
