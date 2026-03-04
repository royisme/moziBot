import type WebSocket from "ws";

/**
 * Format a host for use in a URL. IPv6 addresses are wrapped in brackets.
 * e.g., "::1" -> "[::1]", "127.0.0.1" -> "127.0.0.1", "localhost" -> "localhost"
 */
export function formatHostForUrl(host: string): string {
  const trimmed = host.trim();
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    return trimmed;
  }
  if (trimmed.includes(":") && !trimmed.startsWith("::ffff:")) {
    return `[${trimmed}]`;
  }
  return trimmed;
}

export function rawDataToString(raw: WebSocket.RawData): string {
  if (typeof raw === "string") {
    return raw;
  }
  if (Buffer.isBuffer(raw)) {
    return raw.toString("utf8");
  }
  if (raw instanceof ArrayBuffer) {
    return Buffer.from(raw).toString("utf8");
  }
  if (Array.isArray(raw)) {
    return Buffer.concat(raw).toString("utf8");
  }
  return Buffer.from(raw).toString("utf8");
}
