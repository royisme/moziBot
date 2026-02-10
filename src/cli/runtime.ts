import { Command } from "commander";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../config/loader";
import {
  detectServiceProvider,
  installRuntimeService,
  isRuntimeServiceInstalled,
  isRuntimeServiceRunning,
  uninstallRuntimeService,
} from "../daemon/service-manager";
import { getMemoryManager } from "../memory";
import { Lifecycle, isProcessRunning } from "../runtime/host/lifecycle";
import { resolveRuntimeLaunchTarget } from "./commands/runtime-launch";
import { resolveRuntimePaths } from "./commands/runtime-paths";

export const runtimeCommand = new Command("runtime").description("Manage Mozi Runtime daemon");

runtimeCommand
  .command("status")
  .description("Show Runtime status")
  .option("-c, --config <path>", "Config file path")
  .action(async (options) => {
    const runtime = resolveRuntimePaths(options.config);
    process.env.MOZI_PID_FILE = runtime.pidFile;

    console.log("Mozi Runtime Status");
    console.log("==================");

    const pid = Lifecycle.getPid();
    if (pid !== null && isProcessRunning(pid)) {
      console.log(`Status: Running (PID: ${pid})`);
    } else {
      console.log("Status: Stopped");
    }

    const provider = detectServiceProvider();
    const installed = await isRuntimeServiceInstalled();
    const running = await isRuntimeServiceRunning();
    const providerLabel =
      provider === "none" ? "unsupported" : provider === "systemd" ? "systemd" : "launchd";

    console.log(`Service Provider: ${providerLabel}`);
    console.log(`Service: ${installed ? "Installed" : "Not installed"}`);
    if (installed) {
      console.log(`Service Status: ${running ? "Active" : "Inactive"}`);
    }

    console.log("\nConfiguration:");
    console.log(`  Config: ${runtime.configPath}`);
    console.log(`  Log: ${runtime.logFile}`);
    console.log(`  Data: ${runtime.dataDir}`);

    const configResult = loadConfig(options.config);
    if (configResult.success && configResult.config) {
      const config = configResult.config;
      let defaultAgentId = "mozi";
      if (config.agents) {
        const agentIds = Object.keys(config.agents);
        const mainAgent = agentIds.find((id) => {
          const agent = config.agents?.[id];
          return agent && typeof agent === "object" && "main" in agent && agent.main === true;
        });
        if (mainAgent) {
          defaultAgentId = mainAgent;
        } else if (agentIds.length > 0) {
          const nonDefault = agentIds.find((id) => id !== "defaults");
          if (nonDefault) {
            defaultAgentId = nonDefault;
          }
        }
      }

      try {
        const manager = await getMemoryManager(config, defaultAgentId);
        const status = manager.status();
        console.log("\nMemory Diagnostics:");
        console.log(`  Agent: ${defaultAgentId}`);
        console.log(`  Backend: ${status.backend}`);
        console.log(`  Files/Chunks: ${status.files ?? 0}/${status.chunks ?? 0}`);
        if (status.dbPath) {
          console.log(`  Index Path: ${status.dbPath}`);
        }
        if (status.custom?.qmd && typeof status.custom.qmd === "object") {
          const qmd = status.custom.qmd as Record<string, unknown>;
          if (typeof qmd.lastUpdateAt === "number") {
            console.log(`  Last Update: ${new Date(qmd.lastUpdateAt).toLocaleString()}`);
          }
        }
        if (status.sourceCounts) {
          const counts = status.sourceCounts.map((s) => `${s.source}:${s.files}`).join(", ");
          console.log(`  Sources: ${counts}`);
        }
      } catch (err) {
        console.warn(`\nMemory Diagnostics: Unavailable (${String(err)})`);
      }
    }
  });

runtimeCommand
  .command("start")
  .description("Start Runtime")
  .option("-d, --daemon", "Run as background daemon (default)")
  .option("-f, --foreground", "Run in foreground")
  .option("-c, --config <path>", "Config file path")
  .action(async (options) => {
    if (options.foreground && options.daemon) {
      console.error("Error: --daemon and --foreground cannot be used together.");
      process.exit(1);
    }

    const { startRuntime } = await import("./commands/start");
    await startRuntime(options);
  });

runtimeCommand
  .command("stop")
  .description("Stop Runtime")
  .option("-c, --config <path>", "Config file path")
  .action(async (options) => {
    const { stopRuntime } = await import("./commands/stop");
    await stopRuntime({ config: options.config });
  });

runtimeCommand
  .command("restart")
  .description("Restart Runtime")
  .option("-d, --daemon", "Run as background daemon (default)")
  .option("-f, --foreground", "Run in foreground")
  .option("-c, --config <path>", "Config file path")
  .action(async (options) => {
    if (options.foreground && options.daemon) {
      console.error("Error: --daemon and --foreground cannot be used together.");
      process.exit(1);
    }

    const { stopRuntime } = await import("./commands/stop");
    const { startRuntime } = await import("./commands/start");
    await stopRuntime({ config: options.config });
    await new Promise((resolve) => setTimeout(resolve, 1000));
    await startRuntime(options);
  });

runtimeCommand
  .command("install")
  .description("Install as system service")
  .option("-c, --config <path>", "Config file path")
  .action(async (options) => {
    try {
      const runtime = resolveRuntimePaths(options.config);
      const runtimeScript = path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        "../runtime/host/main.ts",
      );
      const target = resolveRuntimeLaunchTarget({
        cwd: process.cwd(),
        execPath: process.execPath,
        sourceScriptPath: runtimeScript,
      });

      await installRuntimeService({
        command: target.command,
        args: target.args,
        workDir: runtime.baseDir,
        logFile: runtime.logFile,
        env: {
          MOZI_CONFIG: runtime.configPath,
          MOZI_PID_FILE: runtime.pidFile,
          MOZI_DAEMON: "true",
        },
      });
      const provider = detectServiceProvider();
      console.log(`Mozi Runtime installed as ${provider} user service.`);
    } catch (error) {
      console.error(`Failed to install system service: ${String(error)}`);
      process.exit(1);
    }
  });

runtimeCommand
  .command("uninstall")
  .description("Uninstall system service")
  .action(async () => {
    try {
      const provider = detectServiceProvider();
      await uninstallRuntimeService();
      console.log(`Mozi Runtime ${provider} service uninstalled.`);
    } catch (error) {
      console.error(`Failed to uninstall system service: ${String(error)}`);
      process.exit(1);
    }
  });

runtimeCommand
  .command("logs")
  .description("View Runtime logs")
  .option("-c, --config <path>", "Config file path")
  .option("-f, --follow", "Follow log output")
  .option("-n, --lines <n>", "Number of lines", "50")
  .action((options) => {
    const runtime = resolveRuntimePaths(options.config);
    const logFile = runtime.logFile;
    const args = ["-n", options.lines];
    if (options.follow) {
      args.push("-f");
    }
    args.push(logFile);

    const tail = spawn("tail", args, { stdio: "inherit" });
    tail.on("exit", (code) => {
      process.exit(code || 0);
    });
  });
