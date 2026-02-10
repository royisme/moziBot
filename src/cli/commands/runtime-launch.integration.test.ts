import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveRuntimeLaunchTarget } from "./runtime-launch";

describe("resolveRuntimeLaunchTarget", () => {
  it("prefers sibling binary when running compiled cli", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mozi-gw-launch-"));
    const cliPath = path.join(tmp, "mozi");
    const siblingPath = path.join(tmp, "mozi-runtime.mjs");
    fs.writeFileSync(cliPath, "");
    fs.writeFileSync(siblingPath, "");

    const resolved = resolveRuntimeLaunchTarget({
      cwd: tmp,
      execPath: cliPath,
      sourceScriptPath: path.join(tmp, "src/runtime/host/main.ts"),
    });
    expect(resolved.command).toBe("node");
    expect(resolved.args).toEqual([siblingPath]);
    expect(resolved.source).toBe("sibling-binary");
  });

  it("falls back to dist binary in source cli mode", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mozi-gw-launch-"));
    const distPath = path.join(tmp, "dist", "mozi-runtime.mjs");
    fs.mkdirSync(path.dirname(distPath), { recursive: true });
    fs.writeFileSync(distPath, "");

    const resolved = resolveRuntimeLaunchTarget({
      cwd: tmp,
      execPath: "/usr/local/bin/tsx",
      sourceScriptPath: path.join(tmp, "src/runtime/host/main.ts"),
    });
    expect(resolved.command).toBe("node");
    expect(resolved.args).toEqual([distPath]);
    expect(resolved.source).toBe("dist-binary");
  });

  it("falls back to source script when no binary is available", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mozi-gw-launch-"));
    const sourcePath = path.join(tmp, "src/runtime/host/main.ts");

    const resolved = resolveRuntimeLaunchTarget({
      cwd: tmp,
      execPath: "/usr/local/bin/tsx",
      sourceScriptPath: sourcePath,
    });
    expect(resolved.command).toBe("tsx");
    expect(resolved.args).toEqual([sourcePath]);
    expect(resolved.source).toBe("source");
  });
});
