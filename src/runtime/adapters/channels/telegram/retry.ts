import { logger } from "../../../../logger";

const RECOVERABLE_CODES = new Set(["ETIMEDOUT", "ECONNRESET", "ECONNREFUSED", "ENOTFOUND"]);

function isRecoverableError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const err = error as NodeJS.ErrnoException & { error_code?: number };
  // Network errors
  if (err.code && RECOVERABLE_CODES.has(err.code)) {
    return true;
  }
  // Telegram 5xx
  if (err.error_code && err.error_code >= 500) {
    return true;
  }
  // grammy HttpError with 5xx
  const msg = err.message || "";
  if (/5\d\d/.test(msg) && msg.includes("HTTP")) {
    return true;
  }
  return false;
}

function isRateLimitError(error: unknown): { isLimit: boolean; retryAfter: number } {
  if (!(error instanceof Error)) {
    return { isLimit: false, retryAfter: 0 };
  }
  const err = error as { error_code?: number; parameters?: { retry_after?: number } };
  if (err.error_code === 429) {
    return { isLimit: true, retryAfter: (err.parameters?.retry_after ?? 5) * 1000 };
  }
  return { isLimit: false, retryAfter: 0 };
}

export async function withTelegramRetry<T>(
  fn: () => Promise<T>,
  label: string,
  maxRetries = 3,
): Promise<T> {
  const delays = [1000, 2000, 4000];
  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      const { isLimit, retryAfter } = isRateLimitError(error);
      if (isLimit) {
        logger.warn({ label, attempt, retryAfter }, "Telegram rate limit, waiting");
        await new Promise((resolve) => setTimeout(resolve, retryAfter));
        continue;
      }

      if (!isRecoverableError(error) || attempt >= maxRetries) {
        throw error;
      }

      const delay = delays[attempt] ?? 4000;
      logger.warn({ label, attempt, delay, error }, "Telegram API error, retrying");
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw lastError;
}
