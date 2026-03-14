/**
 * Codex usage fetching utility for moziBot.
 *
 * Fetches usage/rate limit information from OpenAI's Codex API.
 */

import { readCodexCliCredentials } from "../runtime/cli-credentials";

const PROVIDER_ID = "openai-codex";
const USAGE_ENDPOINT = "https://chatgpt.com/backend-api/wham/usage";
const DEFAULT_TIMEOUT_MS = 5000;

export type UsageWindow = {
  label: string;
  usedPercent: number;
  resetAt?: number;
};

export type CodexUsageSnapshot = {
  provider: string;
  displayName: string;
  windows: UsageWindow[];
  plan?: string;
  error?: string;
};

type CodexUsageResponse = {
  rate_limit?: {
    primary_window?: {
      limit_window_seconds?: number;
      used_percent?: number;
      reset_at?: number;
    };
    secondary_window?: {
      limit_window_seconds?: number;
      used_percent?: number;
      reset_at?: number;
    };
  };
  plan_type?: string;
  credits?: { balance?: number | string | null };
};

/** Clamp percentage to valid range 0-100. */
function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, Number.isFinite(value) ? value : 0));
}

/**
 * Fetch Codex usage information from the API.
 *
 * @param options.baseDir - Mozi base directory (defaults to ~/.mozi)
 * @param options.accountId - Optional ChatGPT account ID header
 * @param options.timeoutMs - Request timeout in milliseconds (default 5000)
 * @param options.fetchFn - Optional custom fetch function for testing
 * @returns Usage snapshot with rate limit windows and credit balance
 */
export async function fetchCodexUsage(options?: {
  baseDir?: string;
  accountId?: string;
  timeoutMs?: number;
  fetchFn?: typeof fetch;
}): Promise<CodexUsageSnapshot> {
  const accountId = options?.accountId;
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchFn = options?.fetchFn ?? globalThis.fetch;

  const credentials = readCodexCliCredentials();
  if (!credentials) {
    return {
      provider: PROVIDER_ID,
      displayName: "Codex",
      windows: [],
      error: "No Codex CLI credentials",
    };
  }

  const token = credentials.access?.trim();

  if (!token) {
    return {
      provider: PROVIDER_ID,
      displayName: "Codex",
      windows: [],
      error: "No token",
    };
  }

  // Build request headers
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "User-Agent": "moziBot",
    Accept: "application/json",
  };
  if (accountId) {
    headers["ChatGPT-Account-Id"] = accountId;
  }

  // Make the request with timeout
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  try {
    response = await fetchFn(USAGE_ENDPOINT, {
      method: "GET",
      headers,
      signal: controller.signal,
    });
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    if (errorMessage.includes("abort")) {
      return {
        provider: PROVIDER_ID,
        displayName: "Codex",
        windows: [],
        error: "Request timed out",
      };
    }
    return {
      provider: PROVIDER_ID,
      displayName: "Codex",
      windows: [],
      error: errorMessage,
    };
  } finally {
    clearTimeout(timer);
  }

  // Handle HTTP errors
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      return {
        provider: PROVIDER_ID,
        displayName: "Codex",
        windows: [],
        error: "Token expired",
      };
    }
    return {
      provider: PROVIDER_ID,
      displayName: "Codex",
      windows: [],
      error: `HTTP ${response.status}`,
    };
  }

  // Parse response
  let data: CodexUsageResponse;
  try {
    data = (await response.json()) as CodexUsageResponse;
  } catch {
    return {
      provider: PROVIDER_ID,
      displayName: "Codex",
      windows: [],
      error: "Invalid response",
    };
  }

  // Parse rate limit windows
  const windows: UsageWindow[] = [];

  if (data.rate_limit?.primary_window) {
    const pw = data.rate_limit.primary_window;
    const windowHours = Math.round((pw.limit_window_seconds || 10800) / 3600);
    windows.push({
      label: `${windowHours}h`,
      usedPercent: clampPercent(pw.used_percent || 0),
      resetAt: pw.reset_at ? pw.reset_at * 1000 : undefined,
    });
  }

  if (data.rate_limit?.secondary_window) {
    const sw = data.rate_limit.secondary_window;
    const windowHours = Math.round((sw.limit_window_seconds || 86400) / 3600);
    const label = windowHours >= 24 ? "Day" : `${windowHours}h`;
    windows.push({
      label,
      usedPercent: clampPercent(sw.used_percent || 0),
      resetAt: sw.reset_at ? sw.reset_at * 1000 : undefined,
    });
  }

  // Parse credit balance
  let plan = data.plan_type;
  if (data.credits?.balance !== undefined && data.credits.balance !== null) {
    const balance =
      typeof data.credits.balance === "number"
        ? data.credits.balance
        : parseFloat(String(data.credits.balance)) || 0;
    plan = plan ? `${plan} ($${balance.toFixed(2)})` : `$${balance.toFixed(2)}`;
  }

  return {
    provider: PROVIDER_ID,
    displayName: "Codex",
    windows,
    plan,
  };
}
