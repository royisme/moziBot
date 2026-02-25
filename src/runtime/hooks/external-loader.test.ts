import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { MoziConfig } from "../../config";
import { loadExternalHooks } from "./external-loader";
import { clearRuntimeHooks, getRuntimeHookRunner } from "./index";

function createConfig(paths: string[]): MoziConfig {
  return {
    runtime: {
      hooks: {
        enabled: true,
        paths,
      },
    },
  };
}

describe("loadExternalHooks", () => {
  let tempDir = "";

  afterEach(() => {
    clearRuntimeHooks();
    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
      tempDir = "";
    }
  });

  it("registers hooks from a file", () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mozi-hooks-"));
    const hookFile = path.join(tempDir, "hook.ts");
    fs.writeFileSync(
      hookFile,
      "export const hooks = [{ hookName: 'before_reset', handler: async () => {} }];",
      "utf-8",
    );

    const ids = loadExternalHooks(createConfig([hookFile]));
    expect(ids.length).toBe(1);
    expect(getRuntimeHookRunner().hasHooks("before_reset")).toBe(true);
  });

  it("registers hooks from a directory", () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mozi-hooks-"));
    const hookA = path.join(tempDir, "hook-a.ts");
    const hookB = path.join(tempDir, "hook-b.ts");
    fs.writeFileSync(
      hookA,
      "export const hooks = [{ hookName: 'turn_completed', handler: async () => {} }];",
      "utf-8",
    );
    fs.writeFileSync(
      hookB,
      "export const hooks = [{ hookName: 'before_tool_call', handler: async () => {} }];",
      "utf-8",
    );

    const ids = loadExternalHooks(createConfig([tempDir]));
    expect(ids.length).toBe(2);
    const runner = getRuntimeHookRunner();
    expect(runner.hasHooks("turn_completed")).toBe(true);
    expect(runner.hasHooks("before_tool_call")).toBe(true);
  });
});
