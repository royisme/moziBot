import { describe, expect, it } from "vitest";
import { parseCommand } from "./parser";

describe("parseCommand", () => {
  it("parses built-in aliases", () => {
    expect(parseCommand("/model openai/gpt-5")?.name).toBe("switch");
    expect(parseCommand("/id")?.name).toBe("whoami");
    expect(parseCommand("/reason on")?.name).toBe("reasoning");
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
