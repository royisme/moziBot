import { describe, expect, it } from "vitest";
import {
  normalizeTargetId,
  pickDefaultTarget,
  resolveTargetIdFromTargets,
  type BrowserTarget,
} from "./browser-targets";

describe("browser target helpers", () => {
  const targets: BrowserTarget[] = [
    { id: "tab-aaa", type: "page", title: "A" },
    { id: "tab-bbb", type: "page", title: "B" },
    { id: "worker-1", type: "service_worker", title: "W" },
  ];

  it("normalizes id/targetId", () => {
    expect(normalizeTargetId({ id: "x" })).toBe("x");
    expect(normalizeTargetId({ targetId: "y" })).toBe("y");
  });

  it("resolves exact target id", () => {
    const result = resolveTargetIdFromTargets("tab-bbb", targets);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.targetId).toBe("tab-bbb");
    }
  });

  it("resolves unique prefix", () => {
    const result = resolveTargetIdFromTargets("tab-a", targets);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.targetId).toBe("tab-aaa");
    }
  });

  it("flags ambiguous prefix", () => {
    const result = resolveTargetIdFromTargets("tab-", targets);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("ambiguous");
    }
  });

  it("picks last target when available", () => {
    const result = pickDefaultTarget(targets, "tab-bbb");
    expect(result?.id).toBe("tab-bbb");
  });

  it("picks page target as default", () => {
    const result = pickDefaultTarget(targets);
    expect(result?.id).toBe("tab-aaa");
  });
});
