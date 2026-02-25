export function reconnectDelayMs(
  attempt,
  opts = { baseMs: 1000, maxMs: 30000, jitterMs: 1000, random: Math.random },
) {
  const baseMs = Number.isFinite(opts.baseMs) ? opts.baseMs : 1000;
  const maxMs = Number.isFinite(opts.maxMs) ? opts.maxMs : 30000;
  const jitterMs = Number.isFinite(opts.jitterMs) ? opts.jitterMs : 1000;
  const random = typeof opts.random === "function" ? opts.random : Math.random;
  const safeAttempt = Math.max(0, Number.isFinite(attempt) ? attempt : 0);
  const backoff = Math.min(baseMs * 2 ** safeAttempt, maxMs);
  return backoff + Math.max(0, jitterMs) * random();
}

const RELAY_TOKEN_CONTEXT = "mozi-extension-relay-v1";

async function deriveRelayToken(relayAuthToken, port) {
  const token = String(relayAuthToken || "").trim();
  if (!token) {
    throw new Error(
      "Missing relayAuthToken in extension settings (chrome.storage.local.relayAuthToken)",
    );
  }
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(token),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    enc.encode(`${RELAY_TOKEN_CONTEXT}:${port}`),
  );
  const bytes = new Uint8Array(sig);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function buildRelayWsUrl(port, relayAuthToken) {
  const relayToken = await deriveRelayToken(relayAuthToken, port);
  return `ws://127.0.0.1:${port}/extension?token=${encodeURIComponent(relayToken)}`;
}

export function isRetryableReconnectError(err) {
  const message = err instanceof Error ? err.message : String(err || "");
  if (message.includes("Missing relayAuthToken")) {
    return false;
  }
  return true;
}
