import { describe, expect, it } from "vitest";
import { computeNextRun } from "./schedule";

describe("computeNextRun", () => {
  it("returns future date for at schedule", () => {
    const now = Date.now();
    const next = computeNextRun({ kind: "at", atMs: now + 30_000 }, now);
    expect(next).not.toBeNull();
    expect(next?.getTime()).toBe(now + 30_000);
  });

  it("returns null for past at schedule", () => {
    const now = Date.now();
    const next = computeNextRun({ kind: "at", atMs: now - 1 }, now);
    expect(next).toBeNull();
  });

  it("computes next tick for every schedule", () => {
    const now = 1_000;
    const next = computeNextRun({ kind: "every", everyMs: 500, anchorMs: 0 }, now);
    expect(next?.getTime()).toBe(1_500);
  });
});
