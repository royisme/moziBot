import { describe, expect, it } from "vitest";
import { isBypassCommand } from "./command-metadata";

describe("isBypassCommand", () => {
  it("returns true for all bypass commands", () => {
    const bypassCommands = [
      "tasks",
      "status",
      "models",
      "skills",
      "skill",
      "whoami",
      "help",
      "reminders",
      "prompt_digest",
      "heartbeat",
      "context",
    ];

    for (const command of bypassCommands) {
      expect(isBypassCommand(command)).toBe(true);
    }
  });

  it("returns false for queued commands", () => {
    const queuedCommands = [
      "new",
      "reset",
      "compact",
      "switch",
      "reload",
      "acp",
      "setAuth",
      "unsetAuth",
      "think",
      "reasoning",
    ];

    for (const command of queuedCommands) {
      expect(isBypassCommand(command)).toBe(false);
    }
  });

  it("returns false for unknown and empty command names", () => {
    expect(isBypassCommand("unknown")).toBe(false);
    expect(isBypassCommand("")).toBe(false);
  });
});
