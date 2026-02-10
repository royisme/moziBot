import { describe, expect, it } from "vitest";
import { pruneContextMessages } from "./pruner";
import {
  computeEffectiveSettings,
  DEFAULT_CONTEXT_PRUNING_SETTINGS,
  type EffectiveContextPruningSettings,
} from "./settings";

function makeSettings(
  overrides: Partial<EffectiveContextPruningSettings> = {},
): EffectiveContextPruningSettings {
  return {
    ...DEFAULT_CONTEXT_PRUNING_SETTINGS,
    ...overrides,
    softTrim: {
      ...DEFAULT_CONTEXT_PRUNING_SETTINGS.softTrim,
      ...overrides.softTrim,
    },
    protectedTools: overrides.protectedTools ?? DEFAULT_CONTEXT_PRUNING_SETTINGS.protectedTools,
  };
}

function makeToolResult(toolName: string, text: string) {
  return {
    role: "toolResult" as const,
    toolName,
    content: [{ type: "text" as const, text }],
  };
}

function makeUserMessage(text: string) {
  return { role: "user" as const, content: text };
}

function makeAssistantMessage(text: string) {
  return {
    role: "assistant" as const,
    content: [{ type: "text" as const, text }],
  };
}

describe("pruneContextMessages", () => {
  it("returns messages unchanged when pruning is disabled", () => {
    const messages = [makeUserMessage("hello"), makeAssistantMessage("hi")];
    const settings = makeSettings({ enabled: false });

    const result = pruneContextMessages({
      messages,
      settings,
      contextWindowTokens: 1000,
    });

    expect(result.messages).toBe(messages);
    expect(result.stats.charsSaved).toBe(0);
  });

  it("returns messages unchanged when context window is 0", () => {
    const messages = [makeUserMessage("hello")];
    const settings = makeSettings();

    const result = pruneContextMessages({
      messages,
      settings,
      contextWindowTokens: 0,
    });

    expect(result.messages).toBe(messages);
    expect(result.stats.charsSaved).toBe(0);
  });

  it("returns messages unchanged when below soft trim ratio", () => {
    const messages = [makeUserMessage("short"), makeAssistantMessage("reply")];
    const settings = makeSettings({ softTrimRatio: 0.5 });

    const result = pruneContextMessages({
      messages,
      settings,
      contextWindowTokens: 10000,
    });

    expect(result.messages).toBe(messages);
    expect(result.stats.charsSaved).toBe(0);
  });

  it("soft trims large tool results when above soft trim ratio", () => {
    const largeText = "x".repeat(10000);
    const messages = [
      makeUserMessage("start"),
      makeToolResult("bash", largeText),
      makeAssistantMessage("done"),
      makeAssistantMessage("done2"),
      makeAssistantMessage("done3"),
      makeAssistantMessage("current"),
    ];
    const settings = makeSettings({
      softTrimRatio: 0.1,
      keepLastAssistants: 3,
      softTrim: { maxChars: 1000, headChars: 200, tailChars: 200 },
    });

    const result = pruneContextMessages({
      messages,
      settings,
      contextWindowTokens: 5000,
    });

    expect(result.messages).not.toBe(messages);
    expect(result.stats.softTrimCount).toBeGreaterThan(0);
    expect(result.stats.charsSaved).toBeGreaterThan(0);
    const trimmedTool = result.messages[1] as { content: Array<{ text: string }> };
    expect(trimmedTool.content[0].text.length).toBeLessThan(largeText.length);
    expect(trimmedTool.content[0].text).toContain("...");
    expect(trimmedTool.content[0].text).toContain("[Trimmed:");
  });

  it("does not prune protected tools", () => {
    const largeText = "y".repeat(10000);
    const messages = [
      makeUserMessage("start"),
      makeToolResult("read_file", largeText),
      makeAssistantMessage("done"),
      makeAssistantMessage("done2"),
      makeAssistantMessage("done3"),
      makeAssistantMessage("current"),
    ];
    const settings = makeSettings({
      softTrimRatio: 0.1,
      keepLastAssistants: 3,
      protectedTools: new Set(["read_file"]),
    });

    const result = pruneContextMessages({
      messages,
      settings,
      contextWindowTokens: 5000,
    });

    expect(result.messages).toBe(messages);
    expect(result.stats.softTrimCount).toBe(0);
  });

  it("hard clears tool results when soft trim is insufficient", () => {
    const largeText = "z".repeat(50000);
    const messages = [
      makeUserMessage("start"),
      makeToolResult("web_search", largeText),
      makeAssistantMessage("done"),
      makeAssistantMessage("done2"),
      makeAssistantMessage("done3"),
      makeAssistantMessage("current"),
    ];
    const settings = makeSettings({
      softTrimRatio: 0.1,
      hardClearRatio: 0.2,
      keepLastAssistants: 3,
      minPrunableChars: 100,
      hardClearPlaceholder: "[CLEARED]",
      softTrim: { maxChars: 40000, headChars: 15000, tailChars: 15000 },
    });

    const result = pruneContextMessages({
      messages,
      settings,
      contextWindowTokens: 1000,
    });

    expect(result.messages).not.toBe(messages);
    expect(result.stats.hardClearCount).toBeGreaterThan(0);
    const clearedTool = result.messages[1] as { content: Array<{ text: string }> };
    expect(clearedTool.content[0].text).toBe("[CLEARED]");
  });

  it("protects last N assistant turns from pruning", () => {
    const largeText = "a".repeat(10000);
    const messages = [
      makeUserMessage("start"),
      makeToolResult("bash", largeText),
      makeAssistantMessage("protected1"),
      makeAssistantMessage("protected2"),
      makeAssistantMessage("protected3"),
    ];
    const settings = makeSettings({
      softTrimRatio: 0.1,
      keepLastAssistants: 3,
    });

    const result = pruneContextMessages({
      messages,
      settings,
      contextWindowTokens: 5000,
    });

    const assistantMsgs = result.messages.filter(
      (m: unknown) => (m as { role: string }).role === "assistant",
    );
    expect(assistantMsgs.length).toBe(3);
  });

  it("does not prune messages before first user message", () => {
    const largeText = "b".repeat(10000);
    const messages = [
      { role: "assistant" as const, content: [{ type: "text" as const, text: "system init" }] },
      makeToolResult("init_tool", largeText),
      makeUserMessage("first user msg"),
      makeToolResult("bash", largeText),
      makeAssistantMessage("done"),
      makeAssistantMessage("done2"),
      makeAssistantMessage("current"),
    ];
    const settings = makeSettings({
      softTrimRatio: 0.1,
      keepLastAssistants: 3,
    });

    const result = pruneContextMessages({
      messages,
      settings,
      contextWindowTokens: 5000,
    });

    const initTool = result.messages[1] as { content: Array<{ text: string }> };
    expect(initTool.content[0].text).toBe(largeText);
  });

  it("returns correct stats for pruning operations", () => {
    const largeText = "x".repeat(10000);
    const messages = [
      makeUserMessage("start"),
      makeToolResult("bash", largeText),
      makeAssistantMessage("done"),
      makeAssistantMessage("done2"),
      makeAssistantMessage("done3"),
      makeAssistantMessage("current"),
    ];
    const settings = makeSettings({
      softTrimRatio: 0.1,
      keepLastAssistants: 3,
      softTrim: { maxChars: 1000, headChars: 200, tailChars: 200 },
    });

    const result = pruneContextMessages({
      messages,
      settings,
      contextWindowTokens: 5000,
    });

    expect(result.stats.charsBefore).toBeGreaterThan(0);
    expect(result.stats.charsAfter).toBeGreaterThan(0);
    expect(result.stats.charsSaved).toBe(result.stats.charsBefore - result.stats.charsAfter);
    expect(result.stats.ratio).toBeGreaterThanOrEqual(0);
  });
});

describe("computeEffectiveSettings", () => {
  it("returns defaults when given undefined", () => {
    const result = computeEffectiveSettings(undefined);
    expect(result.enabled).toBe(true);
    expect(result.softTrimRatio).toBe(0.5);
    expect(result.hardClearRatio).toBe(0.7);
  });

  it("merges custom config with defaults", () => {
    const result = computeEffectiveSettings({
      enabled: false,
      softTrimRatio: 0.3,
    });
    expect(result.enabled).toBe(false);
    expect(result.softTrimRatio).toBe(0.3);
    expect(result.hardClearRatio).toBe(0.7);
  });

  it("clamps ratios to valid range", () => {
    const result = computeEffectiveSettings({
      softTrimRatio: 2.0,
      hardClearRatio: -1,
    });
    expect(result.softTrimRatio).toBe(1);
    expect(result.hardClearRatio).toBe(0);
  });

  it("includes always-protected tools", () => {
    const result = computeEffectiveSettings({});
    expect(result.protectedTools.has("read_file")).toBe(true);
    expect(result.protectedTools.has("write_file")).toBe(true);
  });

  it("adds custom protected tools", () => {
    const result = computeEffectiveSettings({
      protectedTools: ["custom_tool"],
    });
    expect(result.protectedTools.has("custom_tool")).toBe(true);
    expect(result.protectedTools.has("read_file")).toBe(true);
  });
});
