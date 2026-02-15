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
  return error.message.toLowerCase().includes("already processing a prompt");
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

/**
 * Creates the final user-facing text for an error reply.
 */
export function createErrorReplyText(error: unknown): string {
  const err = toError(error);

  if (isMissingAuthError(err.message)) {
    return buildMissingAuthGuidance(err.message);
  }

  return `Sorry, an error occurred while processing the message: ${err.message}`;
}
