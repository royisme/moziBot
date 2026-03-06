import { describe, expect, it } from "vitest";
import { resolveAgentJobEscalationTarget } from "./policy";

describe("resolveAgentJobEscalationTarget", () => {
  it("keeps short session-local work on continuation", () => {
    expect(
      resolveAgentJobEscalationTarget({
        source: "continuation",
        expectedDelayMs: 5_000,
        longTaskThresholdMs: 15_000,
      }),
    ).toBe("continuation");
  });

  it("escalates reminders to job", () => {
    expect(resolveAgentJobEscalationTarget({ source: "reminder" })).toBe("job");
  });

  it("escalates tool follow-up to job", () => {
    expect(resolveAgentJobEscalationTarget({ source: "tool" })).toBe("job");
  });

  it("escalates explicit detached work to job", () => {
    expect(resolveAgentJobEscalationTarget({ explicitDetached: true })).toBe("job");
  });

  it("escalates long-running work to job", () => {
    expect(
      resolveAgentJobEscalationTarget({
        source: "user",
        expectedDelayMs: 20_000,
        longTaskThresholdMs: 15_000,
      }),
    ).toBe("job");
  });

  it("escalates when async delivery is required", () => {
    expect(resolveAgentJobEscalationTarget({ source: "user", requiresAsyncDelivery: true })).toBe(
      "job",
    );
  });
});
