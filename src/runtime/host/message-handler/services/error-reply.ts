import { classifyPromptFailoverReason } from "./failover-reasons";
import type { FallbackInfo } from "./prompt-runner";

/**
 * Error Classification and Reply Service
 *
 * This module manages error classification and generates user-facing error messages.
 */

/**
 * Normalizes any unknown error into a standard Error object.
 */
export function toError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }
  return new Error(String(error));
}

/**
 * Checks if the error indicates a manual abortion of the operation.
 */
export function isAbortError(error: Error): boolean {
  if (error.name === "AbortError") {
    return true;
  }
  return error.message === "This operation was aborted";
}

/**
 * Checks if the error indicates the agent is already busy.
 */
export function isAgentBusyError(error: Error): boolean {
  const lower = error.message.toLowerCase();
  return (
    lower.includes("already processing a prompt") ||
    lower.includes("agent is already processing") ||
    (lower.includes("already processing") &&
      (lower.includes("specify streamingbehavior") ||
        lower.includes("use steer() or followup() to queue messages")))
  );
}

/**
 * Checks if the error indicates an unsupported input capability.
 */
export function isCapabilityError(error: Error): boolean {
  const message = error.message.toLowerCase();
  return (
    message.includes("image_url") ||
    message.includes("unsupported input") ||
    message.includes("does not support image") ||
    message.includes("does not support audio") ||
    message.includes("does not support video") ||
    message.includes("does not support file")
  );
}

/**
 * Checks if the error message matches missing authentication patterns.
 */
export function isMissingAuthError(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes("auth_missing") ||
    lower.includes("missing auth") ||
    lower.includes("missing authentication")
  );
}

/**
 * Extracts the missing authentication key from the error message.
 */
export function parseMissingAuthKey(message: string): string | null {
  const marker = /AUTH_MISSING[:\s]+([A-Z0-9_]+)/i.exec(message);
  if (marker?.[1]) {
    return marker[1];
  }
  const simple = /missing auth(?:entication)?(?: secret| key)?[:\s]+([A-Z0-9_]+)/i.exec(message);
  if (simple?.[1]) {
    return simple[1];
  }
  return null;
}

/**
 * Builds user-facing guidance for missing authentication secrets.
 */
export function buildMissingAuthGuidance(message: string): string {
  const key = parseMissingAuthKey(message);
  return key
    ? `Missing authentication secret ${key}. Set it with /setAuth set ${key}=<value> [--scope=agent|global].`
    : "Missing authentication secret. Set it with /setAuth set KEY=<value> [--scope=agent|global].";
}

function buildProviderUnavailableGuidance(message: string): string {
  return `Model provider is unavailable or not configured for this turn. Check provider/runtime configuration and try again. Details: ${message}`;
}

function buildTimeoutGuidance(message: string): string {
  return `The model timed out for this turn. Try again, switch to a faster model, or check provider responsiveness. Details: ${message}`;
}

export function buildFallbackNotice(info: FallbackInfo, allowSwitchHint: boolean): string {
  const prefix =
    info.reason === "timeout"
      ? `⚠️ Primary model timed out this turn; using fallback model ${info.toModel} (from ${info.fromModel}).`
      : info.reason === "provider_or_auth_unavailable"
        ? `⚠️ Primary model provider or authentication is unavailable this turn; using fallback model ${info.toModel} (from ${info.fromModel}).`
        : `⚠️ Primary model failed this turn; using fallback model ${info.toModel} (from ${info.fromModel}).`;

  return allowSwitchHint ? `${prefix} You can /switch if you want to keep using it.` : prefix;
}

/**
 * Creates the final user-facing text for an error reply.
 */
export function createErrorReplyText(error: unknown): string {
  const err = toError(error);

  if (isMissingAuthError(err.message)) {
    return buildMissingAuthGuidance(err.message);
  }

  switch (classifyPromptFailoverReason(err)) {
    case "provider_or_auth_unavailable":
      return buildProviderUnavailableGuidance(err.message);
    case "timeout":
      return buildTimeoutGuidance(err.message);
    default:
      return `Sorry, an error occurred while processing the message: ${err.message}`;
  }
}
