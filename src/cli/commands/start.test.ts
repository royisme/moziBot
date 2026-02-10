import { describe, expect, it } from "vitest";
import { resolveRuntimeStartMode } from "./start";

describe("resolveRuntimeStartMode", () => {
  it("defaults to daemon mode", () => {
    expect(resolveRuntimeStartMode()).toBe("daemon");
    expect(resolveRuntimeStartMode({})).toBe("daemon");
  });

  it("uses foreground when explicitly requested", () => {
    expect(resolveRuntimeStartMode({ foreground: true })).toBe("foreground");
  });

  it("keeps compatibility with daemon=false", () => {
    expect(resolveRuntimeStartMode({ daemon: false })).toBe("foreground");
  });

  it("prefers foreground when both flags are present", () => {
    expect(resolveRuntimeStartMode({ daemon: true, foreground: true })).toBe("foreground");
  });
});
