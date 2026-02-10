import { Command } from "commander";
import { runSandboxBootstrap } from "./commands/sandbox";

export const sandboxCommand = new Command("sandbox").description("Manage sandbox backends");

sandboxCommand
  .command("bootstrap")
  .description("Check and prepare sandbox backend dependencies")
  .option("-c, --config <path>", "Config file path")
  .option("--check", "Only check readiness; do not pull/download")
  .option("--auto-only", "Only bootstrap agents with autoBootstrapOnStart enabled")
  .action(async (options) => {
    await runSandboxBootstrap(options);
  });
