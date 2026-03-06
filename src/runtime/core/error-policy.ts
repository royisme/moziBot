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

function clampRetryAfterMs(value: number): number {
  return Math.min(Math.round(value), RETRY_AFTER_MS_CAP);
}

function parseRetryAfterMs(message: string): number | null {
  const lower = message.toLowerCase();
  const secondsMatch = lower.match(
    /retry[- ]?after\s*[:=]?\s*(\d+(?:\.\d+)?)\s*(seconds?|secs?|s)\b/,
  );
  if (secondsMatch) {
    const seconds = Number(secondsMatch[1]);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return clampRetryAfterMs(seconds * 1000);
    }
  }

  const msMatch = lower.match(/retry[- ]?after\s*[:=]?\s*(\d+)\s*(milliseconds?|msecs?|ms)\b/);
  if (msMatch) {
    const ms = Number(msMatch[1]);
    if (Number.isFinite(ms) && ms >= 0) {
      return clampRetryAfterMs(ms);
    }
  }

  const headerLikeMatch = lower.match(/retry[- ]?after\s*[:=]\s*(\d+(?:\.\d+)?)/);
  if (headerLikeMatch) {
    const seconds = Number(headerLikeMatch[1]);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return clampRetryAfterMs(seconds * 1000);
    }
  }

  return null;
}

function toRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function parseRetryAfterValue(raw: unknown, unit: "ms" | "seconds"): number | null {
  if (typeof raw === "number") {
    if (!Number.isFinite(raw) || raw < 0) {
      return null;
    }
    return clampRetryAfterMs(unit === "ms" ? raw : raw * 1000);
  }

  if (typeof raw !== "string") {
    return null;
  }

  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }

  const numeric = Number(trimmed);
  if (Number.isFinite(numeric) && numeric >= 0) {
    return clampRetryAfterMs(unit === "ms" ? numeric : numeric * 1000);
  }

  const dateMs = Date.parse(trimmed);
  if (Number.isFinite(dateMs)) {
    const delta = dateMs - Date.now();
    if (delta >= 0) {
      return clampRetryAfterMs(delta);
    }
  }

  return null;
}

function parseRetryAfterMsFromStructuredError(error: Error): number | null {
  const stack: unknown[] = [error];
  const visited = new Set<object>();

  while (stack.length > 0) {
    const next = stack.pop();
    const record = toRecord(next);
    if (!record) {
      continue;
    }
    if (visited.has(record)) {
      continue;
    }
    visited.add(record);

    const directMs =
      parseRetryAfterValue(record.retryAfterMs, "ms") ??
      parseRetryAfterValue(record.retry_after_ms, "ms") ??
      parseRetryAfterValue(record.retryAfterMillis, "ms");
    if (directMs !== null) {
      return directMs;
    }

    const directSeconds =
      parseRetryAfterValue(record.retryAfter, "seconds") ??
      parseRetryAfterValue(record.retry_after, "seconds") ??
      parseRetryAfterValue(record["retry-after"], "seconds");
    if (directSeconds !== null) {
      return directSeconds;
    }

    const headers = record.headers;
    if (headers instanceof Headers) {
      const headerValue = headers.get("retry-after");
      const parsed = parseRetryAfterValue(headerValue, "seconds");
      if (parsed !== null) {
        return parsed;
      }
    } else {
      const headersRecord = toRecord(headers);
      if (headersRecord) {
        const parsed =
          parseRetryAfterValue(headersRecord["retry-after"], "seconds") ??
          parseRetryAfterValue(headersRecord["Retry-After"], "seconds");
        if (parsed !== null) {
          return parsed;
        }
      }
    }

    for (const key of ["cause", "response", "data", "error", "details", "meta", "metadata"]) {
      if (record[key] !== undefined) {
        stack.push(record[key]);
      }
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

    const shouldRetry =
      isAgentBusyError(error) || isTransientError(message) || isFormatError(message);
    if (shouldRetry && attempt < this.maxRetries) {
      const retryAfterMs =
        parseRetryAfterMsFromStructuredError(error) ?? parseRetryAfterMs(message);
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
