/**
 * Failover Reason Primitives for Host Prompt Execution
 *
 * This module defines the canonical timeout error and failover reason
 * classification helpers for host prompt execution.
 */

/**
 * The set of possible failover reasons for prompt execution.
 */
export type PromptFailoverReason = "timeout" | "execution_failure" | "provider_or_auth_unavailable";

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
    const lower = error.message.toLowerCase();
    return (
      (error as PromptTimeoutError).code === "PROMPT_TIMEOUT" ||
      lower.includes("timed out") ||
      lower.includes("timeout")
    );
  }
  return false;
}

/**
 * Classifies an error into a failover reason.
 *
 * This is the central place for determining whether a prompt failure
 * was due to timeout vs a generic error.
 */
function isProviderOrAuthUnavailableError(error: Error): boolean {
  const lower = error.message.toLowerCase();
  return (
    lower.includes("auth_missing") ||
    lower.includes("missing auth") ||
    lower.includes("missing authentication") ||
    lower.includes("missing authentication secret") ||
    lower.includes("authentication failed") ||
    lower.includes("unauthorized") ||
    lower.includes("unauthenticated") ||
    lower.includes("invalid api key") ||
    lower.includes("invalid token") ||
    lower.includes("api key not found") ||
    lower.includes("provider not configured") ||
    lower.includes("backend not configured") ||
    lower.includes("model provider unavailable") ||
    lower.includes("provider unavailable")
  );
}

export function classifyPromptFailoverReason(error: unknown): PromptFailoverReason {
  if (isPromptTimeoutError(error)) {
    return "timeout";
  }

  const normalized = error instanceof Error ? error : new Error(String(error));
  if (isProviderOrAuthUnavailableError(normalized)) {
    return "provider_or_auth_unavailable";
  }

  return "execution_failure";
}
