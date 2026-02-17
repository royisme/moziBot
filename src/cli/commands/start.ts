import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../../config";
import { Lifecycle } from "../../runtime/host/lifecycle";
import { resolveRuntimeLaunchTarget } from "./runtime-launch";
import { resolveRuntimePaths } from "./runtime-paths";

export type RuntimeStartOptions = {
  config?: string;
  daemon?: boolean;
  foreground?: boolean;
};

export function resolveRuntimeStartMode(
  options: RuntimeStartOptions = {},
): "daemon" | "foreground" {
  if (options.foreground) {
    return "foreground";
  }
  if (options.daemon === false) {
    return "foreground";
  }
  return "daemon";
}

export async function startRuntime(options: RuntimeStartOptions = {}) {
  const runtime = resolveRuntimePaths(options.config);
  process.env.MOZI_PID_FILE = runtime.pidFile;

  const configResult = loadConfig(runtime.configPath);
  if (!configResult.success || !configResult.config) {
    console.error("Error: failed to load configuration.");
    for (const error of configResult.errors ?? []) {
      console.error(`- ${error}`);
    }
    process.exit(1);
  }

  if (Lifecycle.checkExisting()) {
    console.error("Error: Mozi runtime is already running.");
    process.exit(1);
  }

  const runtimeScript = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../runtime/host/main.ts",
  );
  const target = resolveRuntimeLaunchTarget({
    cwd: process.cwd(),
    execPath: process.execPath,
    sourceScriptPath: runtimeScript,
  });

  console.log(`Starting Mozi runtime with config: ${runtime.configPath}`);
  console.log(`Runtime launch source: ${target.source}`);

  const mode = resolveRuntimeStartMode(options);
  if (mode === "daemon") {
    console.log("Running in daemon mode...");
    fs.mkdirSync(runtime.logsDir, { recursive: true });
    fs.mkdirSync(runtime.dataDir, { recursive: true });
    const out = fs.openSync(runtime.logFile, "a");
    const err = fs.openSync(runtime.logFile, "a");

    const subprocess = spawn(target.command, target.args, {
      detached: true,
      stdio: ["ignore", out, err],
      env: {
        ...process.env,
        MOZI_CONFIG: runtime.configPath,
        MOZI_PID_FILE: runtime.pidFile,
        MOZI_DAEMON: "true",
      },
    });

    subprocess.unref();
    console.log(`Runtime started in background (PID: ${subprocess.pid})`);
    console.log(`Logs: ${runtime.logFile}`);
    return;
  }

  console.log("Running in foreground mode...");
  const subprocess = spawn(target.command, target.args, {
    stdio: "inherit",
    env: {
      ...process.env,
      MOZI_CONFIG: runtime.configPath,
      MOZI_PID_FILE: runtime.pidFile,
    },
  });

  subprocess.on("exit", (code) => {
    process.exit(code || 0);
  });
}
