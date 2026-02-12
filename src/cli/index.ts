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

function extractCommandOptions(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object") {
    return {};
  }
  const candidate = value as {
    optsWithGlobals?: () => Record<string, unknown>;
    opts?: () => Record<string, unknown>;
  };
  if (typeof candidate.optsWithGlobals === "function") {
    return candidate.optsWithGlobals();
  }
  if (typeof candidate.opts === "function") {
    return candidate.opts();
  }
  return value as Record<string, unknown>;
}

function resolveActionOptions(first: unknown, second?: unknown): Record<string, unknown> {
  return {
    ...extractCommandOptions(first),
    ...extractCommandOptions(second),
  };
}

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

const configCmd = program
  .command("config")
  .description("Validate or mutate configuration")
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

configCmd
  .command("snapshot [configPath]")
  .description("Show config path/hash snapshot")
  .option("-c, --config <path>", "Config file path")
  .option("--json", "Output machine-readable JSON")
  .action(async (configPath: string | undefined, options, command) => {
    const { snapshotConfig } = await import("./commands/config");
    const resolved = resolveActionOptions(options, command) as { config?: string; json?: boolean };
    await snapshotConfig({
      ...resolved,
      config: configPath ?? resolved.config,
    });
  });

configCmd
  .command("set <path> <value>")
  .description("Set config value at path (value parsed as JSON5)")
  .option("-c, --config <path>", "Config file path")
  .option("--json", "Parse value as JSON/JSON5")
  .option("--if-hash <hash>", "Only mutate if current raw hash matches")
  .action(async (entryPath: string, value: string, options, command) => {
    const { setConfigEntry } = await import("./commands/config");
    const resolved = resolveActionOptions(options, command) as {
      config?: string;
      json?: boolean;
      ifHash?: string;
    };
    await setConfigEntry(entryPath, value, resolved);
  });

configCmd
  .command("unset <path>")
  .description("Remove config value at path")
  .option("-c, --config <path>", "Config file path")
  .option("--if-hash <hash>", "Only mutate if current raw hash matches")
  .action(async (entryPath: string, options, command) => {
    const { unsetConfigEntry } = await import("./commands/config");
    const resolved = resolveActionOptions(options, command) as { config?: string; ifHash?: string };
    await unsetConfigEntry(entryPath, resolved);
  });

configCmd
  .command("patch [patch]")
  .description("Deep-merge patch object into config")
  .option("-c, --config <path>", "Config file path")
  .option("-f, --file <path>", "Read patch object from file")
  .option("--if-hash <hash>", "Only mutate if current raw hash matches")
  .action(async (patch: string | undefined, options, command) => {
    const { patchConfigEntry } = await import("./commands/config");
    const resolved = resolveActionOptions(options, command) as {
      config?: string;
      ifHash?: string;
      file?: string;
    };
    await patchConfigEntry(patch, resolved);
  });

configCmd
  .command("apply [operations]")
  .description("Apply operation array (set/delete/patch) to config")
  .option("-c, --config <path>", "Config file path")
  .option("-f, --file <path>", "Read operations array from file")
  .option("--if-hash <hash>", "Only mutate if current raw hash matches")
  .action(async (operations: string | undefined, options, command) => {
    const { applyConfigOperations } = await import("./commands/config");
    const resolved = resolveActionOptions(options, command) as {
      config?: string;
      ifHash?: string;
      file?: string;
    };
    await applyConfigOperations(operations, resolved);
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
