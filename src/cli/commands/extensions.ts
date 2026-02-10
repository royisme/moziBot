import chalk from "chalk";
import type { ExtensionDiagnostic, LoadedExtension } from "../../extensions";
import { loadConfig } from "../../config/loader";
import { initExtensionsAsync, loadExtensions } from "../../extensions";

async function loadRegistry() {
  const configResult = loadConfig();
  if (!configResult.success || !configResult.config) {
    console.error(chalk.red("Failed to load configuration:"));
    for (const err of configResult.errors ?? []) {
      console.error(`  ${err}`);
    }
    process.exit(1);
  }
  const registry = loadExtensions(configResult.config.extensions);
  await initExtensionsAsync(configResult.config.extensions, registry);
  return { registry, config: configResult.config };
}

function formatEnabled(ext: LoadedExtension): string {
  return ext.enabled ? chalk.green("enabled") : chalk.gray("disabled");
}

function formatDiagnosticLevel(level: ExtensionDiagnostic["level"]): string {
  switch (level) {
    case "error":
      return chalk.red("ERROR");
    case "warn":
      return chalk.yellow("WARN");
    case "info":
      return chalk.blue("INFO");
  }
}

export async function listExtensions(): Promise<void> {
  const { registry } = await loadRegistry();
  const extensions = registry.list();

  if (extensions.length === 0) {
    console.log("No extensions registered.");
    console.log(chalk.gray('Hint: enable an extension in config under "extensions.entries"'));
    return;
  }

  console.log(chalk.bold("Extensions:"));
  console.log("");

  for (const ext of extensions) {
    const status = formatEnabled(ext);
    const tools = ext.manifest.tools.map((t) => t.name).join(", ");
    console.log(`  ${chalk.cyan(ext.manifest.id)} (${ext.manifest.version}) [${status}]`);
    console.log(`    ${ext.manifest.name}`);
    if (ext.manifest.description) {
      console.log(`    ${chalk.gray(ext.manifest.description)}`);
    }
    if (tools) {
      console.log(`    Tools: ${tools}`);
    }
    console.log("");
  }
}

export async function infoExtension(id: string): Promise<void> {
  const { registry, config } = await loadRegistry();
  const ext = registry.get(id);

  if (!ext) {
    console.error(chalk.red(`Extension "${id}" not found.`));
    const available = registry
      .list()
      .map((e) => e.manifest.id)
      .join(", ");
    if (available) {
      console.log(`Available extensions: ${available}`);
    }
    process.exit(1);
  }

  console.log(chalk.bold(`Extension: ${ext.manifest.id}`));
  console.log(`  Name: ${ext.manifest.name}`);
  console.log(`  Version: ${ext.manifest.version}`);
  console.log(`  Status: ${formatEnabled(ext)}`);
  if (ext.manifest.description) {
    console.log(`  Description: ${ext.manifest.description}`);
  }

  console.log("");
  console.log(chalk.bold("  Tools:"));
  for (const tool of ext.manifest.tools) {
    console.log(`    - ${tool.name}: ${tool.description}`);
  }

  if (ext.manifest.skillDirs && ext.manifest.skillDirs.length > 0) {
    console.log("");
    console.log(chalk.bold("  Skill directories:"));
    for (const dir of ext.manifest.skillDirs) {
      console.log(`    - ${dir}`);
    }
  }

  const entryConfig = config.extensions?.entries?.[id];
  if (entryConfig?.config) {
    console.log("");
    console.log(chalk.bold("  Config:"));
    for (const [key, value] of Object.entries(entryConfig.config)) {
      // Redact anything that looks like an API key value
      const display =
        typeof value === "string" && key.toLowerCase().includes("key")
          ? "***REDACTED***"
          : String(value);
      console.log(`    ${key}: ${display}`);
    }
  }

  if (ext.diagnostics.length > 0) {
    console.log("");
    console.log(chalk.bold("  Diagnostics:"));
    for (const diag of ext.diagnostics) {
      console.log(`    [${formatDiagnosticLevel(diag.level)}] ${diag.message}`);
    }
  }
}

export function enableExtension(id: string): void {
  console.log(
    chalk.yellow(
      `To enable extension "${id}", set extensions.entries.${id}.enabled = true in your config file.`,
    ),
  );
  console.log(chalk.gray("Config file location: ~/.mozi/config.jsonc"));
}

export function disableExtension(id: string): void {
  console.log(
    chalk.yellow(
      `To disable extension "${id}", set extensions.entries.${id}.enabled = false in your config file.`,
    ),
  );
  console.log(chalk.gray("Config file location: ~/.mozi/config.jsonc"));
}

export async function doctorExtensions(): Promise<void> {
  const { registry, config } = await loadRegistry();
  const extensions = registry.list();
  const diagnostics = registry.getDiagnostics();

  console.log(chalk.bold("Extension Health Check"));
  console.log("");

  // Overall status
  const enabled = extensions.filter((e) => e.enabled);
  const disabled = extensions.filter((e) => !e.enabled);
  console.log(`  Total extensions: ${extensions.length}`);
  console.log(`  Enabled: ${chalk.green(String(enabled.length))}`);
  console.log(`  Disabled: ${chalk.gray(String(disabled.length))}`);
  console.log("");

  // Master switch
  if (config.extensions?.enabled === false) {
    console.log(
      chalk.yellow("  Warning: extensions subsystem is disabled (extensions.enabled = false)"),
    );
    console.log("");
  }

  // Check each enabled extension
  for (const ext of enabled) {
    console.log(`  ${chalk.cyan(ext.manifest.id)}:`);

    // Check tools
    if (ext.tools.length === 0) {
      console.log(chalk.yellow("    No tools loaded (check diagnostics below)"));
    } else {
      console.log(
        chalk.green(`    ${ext.tools.length} tool(s): ${ext.tools.map((t) => t.name).join(", ")}`),
      );
    }

    // Check API key for Tavily
    if (ext.manifest.id === "web-tavily") {
      const apiKeyEnv =
        (config.extensions?.entries?.["web-tavily"]?.config?.apiKeyEnv as string) ??
        "TAVILY_API_KEY";
      const hasKey = Boolean(process.env[apiKeyEnv]);
      if (hasKey) {
        console.log(chalk.green(`    ${apiKeyEnv}: set`));
      } else {
        console.log(chalk.red(`    ${apiKeyEnv}: NOT SET - web_search will fail at runtime`));
      }
    }

    console.log("");
  }

  // Diagnostics
  if (diagnostics.length > 0) {
    console.log(chalk.bold("  Diagnostics:"));
    for (const diag of diagnostics) {
      console.log(
        `    [${formatDiagnosticLevel(diag.level)}] (${diag.extensionId}) ${diag.message}`,
      );
    }
    console.log("");
  }

  const errors = diagnostics.filter((d) => d.level === "error");
  if (errors.length === 0 && enabled.length > 0) {
    console.log(chalk.green("  All enabled extensions are healthy."));
  } else if (errors.length > 0) {
    console.log(chalk.red(`  ${errors.length} error(s) found. Review diagnostics above.`));
  }
}
