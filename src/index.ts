import path from "node:path";
import "./runtime/pi-package-dir";
import { loadConfig } from "./config";
import { logger } from "./logger";
import { RuntimeHost } from "./runtime/host";
import { initDb } from "./storage/db";
import { APP_VERSION } from "./version";

async function main() {
  const args = process.argv.slice(2);
  const isDaemon = args.includes("--daemon");
  const configArgIndex = args.indexOf("--config");
  const configPath = configArgIndex >= 0 ? args[configArgIndex + 1] : undefined;

  const result = loadConfig(configPath);
  if (!result.success || !result.config) {
    logger.error({ errors: result.errors }, "Failed to load configuration");
    process.exit(1);
  }
  const config = result.config;

  const providerNames = Object.keys(config.models?.providers ?? {});
  const modelDefault = config.agents?.defaults?.model;

  logger.info(`
=========================================
   Mozi v${APP_VERSION}
=========================================
   Config: ${result.path}
   Providers: ${providerNames.join(", ") || "none"}
   Default Model: ${typeof modelDefault === "string" ? modelDefault : ""}
=========================================
  `);

  const baseDir = config.paths?.baseDir;
  const dbPath = baseDir ? path.join(baseDir, "mozi.db") : "data/mozi.db";

  logger.info("Initializing database...");
  initDb(dbPath);

  const runtime = new RuntimeHost({ daemon: isDaemon });

  const shutdown = async (signal: string) => {
    logger.info(`Received ${signal}, shutting down...`);
    await runtime.stop();
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  await runtime.start();
  logger.info("Mozi is running. Press Ctrl+C to stop.");

  if (!isDaemon) {
    await new Promise(() => {});
  }
}

main().catch((err) => {
  logger.error({ err }, "Fatal error during startup");
  process.exit(1);
});
