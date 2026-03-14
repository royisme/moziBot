import { Command } from "commander";

export const configureCommand = new Command("configure")
  .description("Launch the guided configuration wizard")
  .option("-s, --section <name...>", "Run only the specified configure section(s)")
  .option("-c, --config <path>", "Config file path")
  .option("--non-interactive", "Skip prompts and use defaults/environment")
  .action(async (options: { section?: string[]; config?: string; nonInteractive?: boolean }) => {
    const { runConfigureWizard } = await import("../../configure");
    await runConfigureWizard({
      sections: options.section,
      configPath: options.config,
      nonInteractive: options.nonInteractive,
    });
  });
