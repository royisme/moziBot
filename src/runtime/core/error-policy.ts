import type { RuntimeErrorDecision, RuntimeErrorPolicy } from "./contracts";

const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_BASE_DELAY_MS = 1000;

export function isTransientError(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes("already processing a prompt") ||
    lower.includes("timeout") ||
    lower.includes("temporarily unavailable") ||
    lower.includes("network") ||
    lower.includes("rate limit") ||
    lower.includes("503")
  );
}

function isCapabilityError(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes("image_url") ||
    lower.includes("unsupported input") ||
    lower.includes("does not support image")
  );
}

export class DefaultRuntimeErrorPolicy implements RuntimeErrorPolicy {
  constructor(
    private readonly maxRetries: number = DEFAULT_MAX_RETRIES,
    private readonly baseDelayMs: number = DEFAULT_BASE_DELAY_MS,
  ) {}

  decide(error: Error, attempt: number): RuntimeErrorDecision {
    if (isCapabilityError(error.message)) {
      return {
        retry: false,
        delayMs: 0,
        reason: "capability_error",
      };
    }

    if (isTransientError(error.message) && attempt < this.maxRetries) {
      return {
        retry: true,
        delayMs: this.baseDelayMs * 2 ** attempt,
        reason: "transient_error",
      };
    }

    return {
      retry: false,
      delayMs: 0,
      reason: "terminal_error",
    };
  }
}
