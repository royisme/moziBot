import { describe, expect, it } from "vitest";
import { resolveRuntimePaths } from "./runtime-paths";

describe("resolveRuntimePaths", () => {
  it("derives runtime files from explicit config path", () => {
    const resolved = resolveRuntimePaths("/tmp/mozi/config.jsonc");
    expect(resolved.baseDir).toBe("/tmp/mozi");
    expect(resolved.pidFile).toBe("/tmp/mozi/data/mozi.pid");
    expect(resolved.logFile).toBe("/tmp/mozi/logs/runtime.log");
  });
});
