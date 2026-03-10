import { Command } from "commander";

export const subagentCommand = new Command("subagent").description("Manage subagent runs");

subagentCommand
  .command("list")
  .description("List subagent runs")
  .option("-c, --config <path>", "Config file path")
  .option("--json", "Output as JSON")
  .option("-a, --all", "Show all runs (including completed)")
  .action(async (options) => {
    const { subagentList } = await import("./subagent-list");
    await subagentList(options);
  });

subagentCommand
  .command("status <runId>")
  .description("Show subagent run status")
  .option("-c, --config <path>", "Config file path")
  .option("--json", "Output as JSON")
  .action(async (runId: string, options) => {
    const { subagentStatus } = await import("./subagent-status");
    await subagentStatus(runId, options);
  });
