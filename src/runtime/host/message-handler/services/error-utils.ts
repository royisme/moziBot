export function toError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }
  return new Error(String(error));
}

export function isAgentBusyError(error: unknown): boolean {
  const normalized = toError(error);
  return normalized.message.toLowerCase().includes("already processing a prompt");
}

export function isAbortError(error: Error): boolean {
  if (error.name === "AbortError") {
    return true;
  }
  return error.message === "This operation was aborted";
}
