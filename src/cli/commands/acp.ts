import { Command } from "commander";

export const acpCommand = new Command("acp").description("Manage ACP sessions");

acpCommand
  .command("spawn [backend]")
  .description("Spawn a new ACP session")
  .option("-c, --config <path>", "Config file path")
  .option("-a, --agent <agent>", "Agent ID to use")
  .option("-m, --mode <mode>", "Session mode (persistent|oneshot)", "persistent")
  .option("--cwd <cwd>", "Working directory")
  .action(async (backend: string | undefined, options) => {
    const { acpSpawn } = await import("./acp-spawn");
    await acpSpawn(backend, options);
  });

acpCommand
  .command("cancel <sessionKey>")
  .description("Cancel a running ACP session")
  .option("-c, --config <path>", "Config file path")
  .action(async (sessionKey: string, options) => {
    const { acpCancel } = await import("./acp-cancel");
    await acpCancel(sessionKey, options);
  });

acpCommand
  .command("status <sessionKey>")
  .description("Show ACP session status")
  .option("-c, --config <path>", "Config file path")
  .option("--json", "Output as JSON")
  .action(async (sessionKey: string, options) => {
    const { acpStatus } = await import("./acp-status");
    await acpStatus(sessionKey, options);
  });

acpCommand
  .command("list")
  .description("List all ACP sessions")
  .option("-c, --config <path>", "Config file path")
  .option("--json", "Output as JSON")
  .action(async (options) => {
    const { acpList } = await import("./acp-list");
    await acpList(options);
  });

acpCommand
  .command("bridge")
  .description("Start ACP Bridge server (for internal use)")
  .option("-c, --config <path>", "Config file path")
  .option("--default-session <key>", "Default session key")
  .option("--verbose", "Enable verbose logging")
  .action(async (options) => {
    const { acpBridge } = await import("./acp-bridge");
    await acpBridge(options);
  });

acpCommand
  .command("doctor")
  .description("Check ACP configuration consistency")
  .option("-c, --config <path>", "Config file path")
  .option("--json", "Output as JSON")
  .option("--verbose", "Show detailed output including passed checks")
  .action(async (options) => {
    const { acpDoctor } = await import("./acp-doctor");
    await acpDoctor(options);
  });
