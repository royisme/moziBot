import { logger } from "../../logger";
import {
  formatTelegramError,
  isGetUpdatesConflict,
  isRecoverableTelegramNetworkError,
} from "../adapters/channels/telegram/network-errors";

declare global {
  // eslint-disable-next-line no-var
  var __moziProcessErrorHandlersRegistered: boolean | undefined;
}

function isRecoverableRuntimeError(err: unknown): boolean {
  return (
    isGetUpdatesConflict(err) || isRecoverableTelegramNetworkError(err, { context: "polling" })
  );
}

export function registerProcessErrorHandlers(): void {
  if (globalThis.__moziProcessErrorHandlersRegistered) {
    return;
  }
  globalThis.__moziProcessErrorHandlersRegistered = true;

  process.on("unhandledRejection", (reason) => {
    if (isRecoverableRuntimeError(reason)) {
      logger.warn(
        { error: formatTelegramError(reason), recoverable: true },
        "Suppressed recoverable unhandled rejection",
      );
      return;
    }
    logger.error({ error: formatTelegramError(reason) }, "Unhandled rejection");
  });

  process.on("uncaughtException", (error) => {
    if (isRecoverableRuntimeError(error)) {
      logger.warn(
        { error: formatTelegramError(error), recoverable: true },
        "Suppressed recoverable uncaught exception",
      );
      return;
    }

    logger.fatal({ error: formatTelegramError(error) }, "Uncaught exception");
    process.exitCode = 1;
  });
}
