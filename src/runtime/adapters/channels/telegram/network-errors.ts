export type TelegramNetworkErrorContext = "polling" | "startup" | "send" | "unknown";

const RECOVERABLE_ERROR_CODES = new Set([
  "ENOTFOUND",
  "EAI_AGAIN",
  "ETIMEDOUT",
  "ECONNRESET",
  "ECONNREFUSED",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EPIPE",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
  "ABORT_ERR",
]);

const RECOVERABLE_TEXT_RE =
  /enotfound|eai_again|timed?\s*out|ecconnreset|connection\s*reset|fetch failed|socket|temporary|temporarily|network\s*error|dns|getaddrinfo|unavailable|gateway\s*timeout|service\s*unavailable|bad\s*gateway/i;

const TELEGRAM_SERVER_RETRY_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  return value as UnknownRecord;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function normalizeCode(code: unknown): string | undefined {
  const raw = readString(code);
  return raw ? raw.toUpperCase() : undefined;
}

function collectErrorLikeChain(err: unknown): UnknownRecord[] {
  const chain: UnknownRecord[] = [];
  const queue: unknown[] = [err];
  const seen = new Set<unknown>();

  while (queue.length > 0) {
    const item = queue.shift();
    if (!item || seen.has(item)) {
      continue;
    }
    seen.add(item);

    const record = asRecord(item);
    if (!record) {
      continue;
    }
    chain.push(record);

    const nested = [record.error, record.cause, record.response, record.err];
    for (const value of nested) {
      if (value && typeof value === "object") {
        queue.push(value);
      }
    }
  }

  return chain;
}

export function formatTelegramError(err: unknown): string {
  const redact = (value: string) => value.replace(/bot\d+:[A-Za-z0-9_-]+/g, "bot<redacted>");

  if (err instanceof Error) {
    return redact(err.message);
  }
  if (typeof err === "string") {
    return redact(err);
  }
  try {
    return redact(JSON.stringify(err));
  } catch {
    return redact(String(err));
  }
}

export function isGetUpdatesConflict(err: unknown): boolean {
  for (const record of collectErrorLikeChain(err)) {
    const errorCode = readNumber(record.error_code) ?? readNumber(record.errorCode);
    if (errorCode !== 409) {
      continue;
    }
    const haystack = [record.method, record.description, record.message]
      .map(readString)
      .filter((value): value is string => Boolean(value))
      .join(" ")
      .toLowerCase();
    if (haystack.includes("getupdates")) {
      return true;
    }
  }
  return false;
}

export function isRecoverableTelegramNetworkError(
  err: unknown,
  _opts: { context?: TelegramNetworkErrorContext } = {},
): boolean {
  for (const record of collectErrorLikeChain(err)) {
    const code =
      normalizeCode(record.code) ?? normalizeCode(record.errno) ?? normalizeCode(record.type);
    if (code && RECOVERABLE_ERROR_CODES.has(code)) {
      return true;
    }

    const status =
      readNumber(record.statusCode) ??
      readNumber(record.status) ??
      readNumber(record.error_code) ??
      readNumber(record.errorCode);
    if (status && TELEGRAM_SERVER_RETRY_STATUS.has(status)) {
      return true;
    }

    const message = [record.message, record.description, record.reason]
      .map(readString)
      .filter((value): value is string => Boolean(value))
      .join(" ");
    if (message && RECOVERABLE_TEXT_RE.test(message)) {
      return true;
    }
  }

  const fallback = formatTelegramError(err);
  return RECOVERABLE_TEXT_RE.test(fallback);
}
