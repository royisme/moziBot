export function toError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }
  return new Error(String(error));
}

export function isAgentBusyError(error: unknown): boolean {
  const normalized = toError(error);
  const lower = normalized.message.toLowerCase();
  return (
    lower.includes("already processing a prompt") ||
    lower.includes("agent is already processing") ||
    (lower.includes("already processing") &&
      (lower.includes("specify streamingbehavior") ||
        lower.includes("use steer() or followup() to queue messages")))
  );
}

export function isAbortError(error: Error): boolean {
  if (error.name === "AbortError") {
    return true;
  }
  return error.message === "This operation was aborted";
}
