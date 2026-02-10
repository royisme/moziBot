import pino from "pino";

export const LOG_LEVELS = ["fatal", "error", "warn", "info", "debug", "trace"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];
const DEFAULT_LOG_LEVEL: LogLevel = "info";

function shouldColorizeLogs(): boolean {
  if (process.env.NO_COLOR === "1" || process.env.NO_COLOR === "true") {
    return false;
  }
  if (process.env.MOZI_DAEMON === "true") {
    return false;
  }
  return process.stdout.isTTY;
}

export const logger = pino({
  level: process.env.LOG_LEVEL || DEFAULT_LOG_LEVEL,
  transport: {
    target: "pino-pretty",
    options: {
      colorize: shouldColorizeLogs(),
    },
  },
});

export function configureLogger(level?: string): void {
  const normalized = (level || process.env.LOG_LEVEL || DEFAULT_LOG_LEVEL).trim().toLowerCase();
  if ((LOG_LEVELS as readonly string[]).includes(normalized)) {
    logger.level = normalized;
    return;
  }
  logger.warn({ level }, "Invalid logger level in config; keeping current level");
}
