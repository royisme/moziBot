import { isAgentBusyError } from "../host/message-handler/services/error-utils";
import type { RuntimeErrorDecision, RuntimeErrorPolicy } from "./contracts";

const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_BASE_DELAY_MS = 1000;
const RETRY_AFTER_MS_CAP = 5 * 60 * 1000;

export function isTransientError(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes("timeout") ||
    lower.includes("temporarily unavailable") ||
    lower.includes("network") ||
    lower.includes("rate limit") ||
    lower.includes("503") ||
    lower.includes("econnreset") ||
    lower.includes("econnrefused") ||
    lower.includes("etimedout") ||
    lower.includes("socket hang up") ||
    lower.includes("500") ||
    lower.includes("502") ||
    lower.includes("504") ||
    lower.includes("service unavailable") ||
    lower.includes("bad gateway")
  );
}

export function isFormatError(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes("invalid json") ||
    lower.includes("json parse") ||
    lower.includes("unexpected token") ||
    (lower.includes("tool_use") && lower.includes("schema")) ||
    lower.includes("malformed") ||
    lower.includes("invalid tool") ||
    lower.includes("parse error")
  );
}

export function isAuthOrBillingError(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes("401") ||
    lower.includes("402") ||
    lower.includes("403") ||
    lower.includes("unauthorized") ||
    lower.includes("billing") ||
    lower.includes("quota exceeded") ||
    lower.includes("insufficient")
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

function parseRetryAfterMs(message: string): number | null {
  const lower = message.toLowerCase();
  const secondsMatch = lower.match(/retry[- ]?after\s*[:=]?\s*(\d+(?:\.\d+)?)\s*(seconds?|secs?|s)\b/);
  if (secondsMatch) {
    const seconds = Number(secondsMatch[1]);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(Math.round(seconds * 1000), RETRY_AFTER_MS_CAP);
    }
  }

  const msMatch = lower.match(/retry[- ]?after\s*[:=]?\s*(\d+)\s*(milliseconds?|msecs?|ms)\b/);
  if (msMatch) {
    const ms = Number(msMatch[1]);
    if (Number.isFinite(ms) && ms >= 0) {
      return Math.min(Math.round(ms), RETRY_AFTER_MS_CAP);
    }
  }

  const headerLikeMatch = lower.match(/retry[- ]?after\s*[:=]\s*(\d+(?:\.\d+)?)/);
  if (headerLikeMatch) {
    const seconds = Number(headerLikeMatch[1]);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(Math.round(seconds * 1000), RETRY_AFTER_MS_CAP);
    }
  }

  return null;
}

export class DefaultRuntimeErrorPolicy implements RuntimeErrorPolicy {
  constructor(
    private readonly maxRetries: number = DEFAULT_MAX_RETRIES,
    private readonly baseDelayMs: number = DEFAULT_BASE_DELAY_MS,
  ) {}

  decide(error: Error, attempt: number): RuntimeErrorDecision {
    const message = error.message;

    if (isCapabilityError(message)) {
      return {
        retry: false,
        delayMs: 0,
        reason: "capability_error",
      };
    }

    if (isAuthOrBillingError(message)) {
      return { retry: false, delayMs: 0, reason: "auth_billing_error" };
    }

    const shouldRetry = isAgentBusyError(error) || isTransientError(message) || isFormatError(message);
    if (shouldRetry && attempt < this.maxRetries) {
      const retryAfterMs = parseRetryAfterMs(message);
      return {
        retry: true,
        delayMs: retryAfterMs ?? this.baseDelayMs * 2 ** attempt,
        reason: isAgentBusyError(error)
          ? "busy_error"
          : isFormatError(message)
            ? "format_error"
            : "transient_error",
      };
    }

    return {
      retry: false,
      delayMs: 0,
      reason: "terminal_error",
    };
  }
}
