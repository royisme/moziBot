/**
 * Failover Reason Primitives for Host Prompt Execution
 *
 * This module defines the canonical timeout error and failover reason
 * classification helpers for host prompt execution.
 */

import { toError } from "./error-utils";

/**
 * The set of possible failover reasons for prompt execution.
 */
export type PromptFailoverReason = "timeout" | "error";

/**
 * Canonical error thrown when a prompt execution times out.
 *
 * This is distinct from AbortError - timeout is a legitimate operational
 * reason that should be eligible for fallback model routing.
 */
export class PromptTimeoutError extends Error {
  readonly code = "PROMPT_TIMEOUT";
  readonly timeoutMs: number;

  constructor(timeoutMs: number, message = "Agent prompt timed out") {
    super(message);
    this.name = "PromptTimeoutError";
    this.timeoutMs = timeoutMs;
    // Maintains proper stack trace in V8 environments
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, PromptTimeoutError);
    }
  }
}

/**
 * Type guard to check if an error is a PromptTimeoutError.
 */
export function isPromptTimeoutError(error: unknown): error is PromptTimeoutError {
  if (error instanceof PromptTimeoutError) {
    return true;
  }
  if (error instanceof Error) {
    return (error as PromptTimeoutError).code === "PROMPT_TIMEOUT";
  }
  return false;
}

/**
 * Classifies an error into a failover reason.
 *
 * This is the central place for determining whether a prompt failure
 * was due to timeout vs a generic error.
 */
export function classifyPromptFailoverReason(error: unknown): PromptFailoverReason {
  const err = toError(error);

  if (isPromptTimeoutError(err)) {
    return "timeout";
  }

  return "error";
}
