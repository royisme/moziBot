import fs from "node:fs";
import path from "node:path";

export type RuntimeLaunchTarget = {
  command: string;
  args: string[];
  source: "sibling-binary" | "dist-binary" | "source";
};

export function resolveRuntimeLaunchTarget(params: {
  cwd: string;
  execPath: string;
  sourceScriptPath: string;
}): RuntimeLaunchTarget {
  const siblingBinary = path.join(path.dirname(params.execPath), "mozi-runtime.mjs");
  if (isLikelyCompiledCli(params.execPath) && fs.existsSync(siblingBinary)) {
    return { command: "node", args: [siblingBinary], source: "sibling-binary" };
  }

  const distBinary = path.resolve(params.cwd, "dist/mozi-runtime.mjs");
  if (fs.existsSync(distBinary)) {
    return { command: "node", args: [distBinary], source: "dist-binary" };
  }

  return { command: "tsx", args: [params.sourceScriptPath], source: "source" };
}

function isLikelyCompiledCli(execPath: string): boolean {
  const base = path.basename(execPath).toLowerCase();
  return base !== "node" && base !== "tsx";
}
