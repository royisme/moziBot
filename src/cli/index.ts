#!/usr/bin/env node
import { Command } from "commander";
import "../runtime/pi-package-dir";
import { APP_VERSION } from "../version";
import { runtimeCommand } from "./runtime";
import { sandboxCommand } from "./sandbox";

const program = new Command()
  .name("mozi")
  .description("Mozi AI Agent Platform")
  .version(APP_VERSION);

program.addCommand(runtimeCommand);
program.addCommand(sandboxCommand);

program
  .command("init")
  .description("Initialize Mozi configuration and workspace")
  .option("--reset", "Force overwrite existing configuration")
  .option("--non-interactive", "Use defaults without prompting")
  .action(async (options) => {
    const { runInitWizard } = await import("./commands/init");
    await runInitWizard(options);
  });

program
  .command("setup")
  .description("Create missing home and workspace files")
  .option("-h, --home <path>", "Agent home directory")
  .option("-w, --workspace <path>", "Workspace directory")
  .action(async (options) => {
    const { runSetup } = await import("./commands/init");
    await runSetup(options);
  });

program
  .command("health")
  .description("Check Mozi system health")
  .action(async () => {
    const { runHealth } = await import("./commands/health");
    await runHealth();
  });

program
  .command("config")
  .description("Validate or inspect configuration")
  .option("-c, --config <path>", "Config file path")
  .option("--doctor", "Run extended validation checks")
  .option("--fix", "Try to bootstrap sandbox dependencies (with --doctor)")
  .action(async (options) => {
    const { validateConfig, doctorConfig } = await import("./commands/config");
    if (options.doctor) {
      await doctorConfig(options.config, { fix: options.fix });
      return;
    }
    await validateConfig(options.config);
  });

program
  .command("doctor")
  .description("Validate configuration is runnable")
  .option("-c, --config <path>", "Config file path")
  .option("--fix", "Try to bootstrap sandbox dependencies")
  .action(async (options) => {
    const { doctorConfig } = await import("./commands/config");
    await doctorConfig(options.config, { fix: options.fix });
  });

program
  .command("chat")
  .description("Start Mozi TUI chat")
  .action(async () => {
    const { runChat } = await import("../tui");
    await runChat();
  });

// Auth / secrets management
const authCmd = program.command("auth").description("Manage API keys in ~/.mozi/.env");

authCmd
  .command("set <target>")
  .description("Set API key for tavily/brave, or by ENV var name")
  .option("-c, --config <path>", "Config file path")
  .option("-v, --value <value>", "Key value (omit to prompt)")
  .action(async (target: string, options) => {
    const { authSet } = await import("./commands/auth");
    await authSet(target, options);
  });

authCmd
  .command("list")
  .description("List auth key status")
  .option("-c, --config <path>", "Config file path")
  .action(async (options) => {
    const { authList } = await import("./commands/auth");
    await authList(options);
  });

authCmd
  .command("remove <target>")
  .description("Remove API key for tavily/brave, or by ENV var name")
  .option("-c, --config <path>", "Config file path")
  .action(async (target: string, options) => {
    const { authRemove } = await import("./commands/auth");
    await authRemove(target, options);
  });

// Extensions management
const extensionsCmd = program.command("extensions").description("Manage Mozi extensions");

extensionsCmd
  .command("list")
  .description("List all registered extensions")
  .action(async () => {
    const { listExtensions } = await import("./commands/extensions");
    await listExtensions();
  });

extensionsCmd
  .command("info <id>")
  .description("Show detailed information about an extension")
  .action(async (id: string) => {
    const { infoExtension } = await import("./commands/extensions");
    await infoExtension(id);
  });

extensionsCmd
  .command("enable <id>")
  .description("Show instructions to enable an extension")
  .action(async (id: string) => {
    const { enableExtension } = await import("./commands/extensions");
    enableExtension(id);
  });

extensionsCmd
  .command("disable <id>")
  .description("Show instructions to disable an extension")
  .action(async (id: string) => {
    const { disableExtension } = await import("./commands/extensions");
    disableExtension(id);
  });

extensionsCmd
  .command("doctor")
  .description("Run extension health diagnostics")
  .action(async () => {
    const { doctorExtensions } = await import("./commands/extensions");
    await doctorExtensions();
  });

program.parse();

export { program };
