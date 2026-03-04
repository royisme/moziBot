import { describe, expect, it } from "vitest";
import { parseCommand } from "./parser";

describe("parseCommand", () => {
  it("parses command parity matrix", () => {
    const cases: Array<{ input: string; expected: { name: string; args: string } | null }> = [
      { input: "/help", expected: { name: "help", args: "" } },
      { input: "/status", expected: { name: "status", args: "" } },
      { input: "/models", expected: { name: "models", args: "" } },
      { input: "/skills", expected: { name: "skills", args: "" } },
      { input: "/new", expected: { name: "new", args: "" } },
      { input: "/reset", expected: { name: "reset", args: "" } },
      { input: "/stop", expected: { name: "stop", args: "" } },
      { input: "/switch openai/gpt-5", expected: { name: "switch", args: "openai/gpt-5" } },
      { input: "/switch   openai/gpt-5  ", expected: { name: "switch", args: "openai/gpt-5" } },
      { input: "   /help   ", expected: { name: "help", args: "" } },
      { input: "/model openai/gpt-5", expected: { name: "switch", args: "openai/gpt-5" } },
      { input: "/id", expected: { name: "whoami", args: "" } },
      { input: "/t high", expected: { name: "think", args: "high" } },
      { input: "/reason on", expected: { name: "reasoning", args: "on" } },
      { input: "/unknown_cmd", expected: { name: "unknown_cmd", args: "" } },
      { input: "/unknown_cmd   arg1  arg2", expected: { name: "unknown_cmd", args: "arg1  arg2" } },
      { input: "/123", expected: null },
      { input: "/$bad", expected: null },
      { input: "hello", expected: null },
    ];

    for (const { input, expected } of cases) {
      expect(parseCommand(input)).toEqual(expected);
    }
  });

  it("parses extension-like slash commands", () => {
    const parsed = parseCommand("/ext_ping hello world");
    expect(parsed).toEqual({ name: "ext_ping", args: "hello world" });
  });

  it("rejects invalid command tokens", () => {
    expect(parseCommand("/123")).toBeNull();
    expect(parseCommand("/$bad")).toBeNull();
  });
});
