import { z } from "zod";
import type { MoziConfig } from "../../config";
import { ensureChromeExtensionRelayServer } from "../../runtime/browser/extension-relay";
import {
  RELAY_AUTH_HEADER,
  resolveRelayAuthTokenForPort,
} from "../../runtime/browser/extension-relay-auth";
import { detectSuspiciousPatterns, wrapExternalContent } from "../../security/external-content";

type BrowserDriver = "extension" | "cdp";

type BrowserProfile = {
  driver: BrowserDriver;
  cdpUrl: string;
};

export const browserToolSchema = z.object({
  action: z.enum(["status", "tabs"]),
  profile: z.string().optional(),
  timeoutMs: z.number().int().positive().optional(),
});

export type BrowserToolParams = z.infer<typeof browserToolSchema>;

export type BrowserToolContext = {
  getConfig: () => MoziConfig;
};

type BrowserToolResult = {
  content: Array<{ type: string; text: string }>;
  details: Record<string, unknown>;
};

type ExtensionStatus = { connected: boolean };

const DEFAULT_TIMEOUT_MS = 2000;

function resolveBrowserProfile(
  config: MoziConfig,
  profileName?: string,
): { name: string; profile: BrowserProfile; relayEnabled: boolean } {
  const browser = config.browser;
  if (browser?.enabled === false) {
    throw new Error("Browser tools are disabled (browser.enabled=false).");
  }
  const profiles = browser?.profiles ?? {};
  const name = profileName ?? browser?.defaultProfile;
  if (!name) {
    throw new Error("Browser profile is required (set browser.defaultProfile or pass profile).");
  }
  const profile = profiles[name];
  if (!profile) {
    throw new Error(`Browser profile not found: ${name}`);
  }
  return { name, profile, relayEnabled: browser?.relay?.enabled === true };
}

function resolveBaseUrl(cdpUrl: string): string {
  return cdpUrl.trim().replace(/\/$/, "");
}

async function fetchJson<T>(
  url: string,
  opts?: { headers?: Record<string, string>; timeoutMs?: number },
): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    Math.max(1, opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS),
  );
  try {
    const res = await fetch(url, {
      headers: opts?.headers,
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status} ${res.statusText}${body ? `: ${body}` : ""}`);
    }
    return (await res.json()) as T;
  } finally {
    clearTimeout(timeout);
  }
}

function wrapBrowserPayload(kind: "tabs" | "status", payload: unknown): BrowserToolResult {
  const rawText = JSON.stringify(payload, null, 2);
  const wrappedText = wrapExternalContent(rawText, {
    source: "browser",
    includeWarning: kind === "tabs",
  });
  const suspiciousPatterns = detectSuspiciousPatterns(rawText);
  const details: Record<string, unknown> = {
    externalContent: {
      untrusted: true,
      source: "browser",
      kind,
      wrapped: true,
    },
  };
  if (suspiciousPatterns.length > 0) {
    details.suspiciousPatterns = suspiciousPatterns;
  }
  return { content: [{ type: "text", text: wrappedText }], details };
}

async function getRelayHeaders(
  config: MoziConfig,
  cdpUrl: string,
): Promise<Record<string, string>> {
  const parsed = new URL(cdpUrl);
  const port = parsed.port ? Number(parsed.port) : parsed.protocol === "https:" ? 443 : 80;
  if (!Number.isFinite(port) || port <= 0) {
    throw new Error("Invalid relay port in cdpUrl.");
  }
  const token = resolveRelayAuthTokenForPort(config, port);
  return { [RELAY_AUTH_HEADER]: token };
}

async function loadExtensionStatus(baseUrl: string, timeoutMs?: number): Promise<ExtensionStatus> {
  return await fetchJson<ExtensionStatus>(`${baseUrl}/extension/status`, { timeoutMs });
}

export async function runBrowserTool(
  ctx: BrowserToolContext,
  params: BrowserToolParams,
): Promise<BrowserToolResult> {
  try {
    const config = ctx.getConfig();
    const { name, profile, relayEnabled } = resolveBrowserProfile(config, params.profile);
    const baseUrl = resolveBaseUrl(profile.cdpUrl);
    const timeoutMs = params.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    if (profile.driver === "extension") {
      if (!relayEnabled) {
        return {
          content: [
            {
              type: "text",
              text: "Browser relay is disabled. Set browser.relay.enabled=true to use extension profiles.",
            },
          ],
          details: {},
        };
      }
      await ensureChromeExtensionRelayServer({
        cdpUrl: profile.cdpUrl,
        config,
        bindHost: config.browser?.relay?.bindHost,
      });
    }

    if (params.action === "status") {
      if (profile.driver === "extension") {
        const headers = await getRelayHeaders(config, profile.cdpUrl);
        const [version, extension] = await Promise.all([
          fetchJson<Record<string, unknown>>(`${baseUrl}/json/version`, {
            headers,
            timeoutMs,
          }),
          loadExtensionStatus(baseUrl, timeoutMs).catch(() => ({ connected: false })),
        ]);
        const payload = {
          ok: true,
          profile: name,
          driver: profile.driver,
          cdpUrl: profile.cdpUrl,
          relay: {
            enabled: true,
            extensionConnected: extension.connected,
          },
          version,
        };
        return wrapBrowserPayload("status", payload);
      }

      const version = await fetchJson<Record<string, unknown>>(`${baseUrl}/json/version`, {
        timeoutMs,
      });
      const payload = {
        ok: true,
        profile: name,
        driver: profile.driver,
        cdpUrl: profile.cdpUrl,
        version,
      };
      return wrapBrowserPayload("status", payload);
    }

    if (profile.driver === "extension") {
      const extension = await loadExtensionStatus(baseUrl, timeoutMs).catch(() => ({
        connected: false,
      }));
      if (!extension.connected) {
        return {
          content: [
            {
              type: "text",
              text: "Relay is running but no tab is attached. Click the browser extension icon to attach.",
            },
          ],
          details: { relay: { extensionConnected: false } },
        };
      }
      const headers = await getRelayHeaders(config, profile.cdpUrl);
      const tabs = await fetchJson<unknown[]>(`${baseUrl}/json/list`, { headers, timeoutMs });
      return wrapBrowserPayload("tabs", { profile: name, driver: profile.driver, tabs });
    }

    const tabs = await fetchJson<unknown[]>(`${baseUrl}/json/list`, { timeoutMs });
    return wrapBrowserPayload("tabs", { profile: name, driver: profile.driver, tabs });
  } catch (error) {
    return {
      content: [
        {
          type: "text",
          text: error instanceof Error ? error.message : String(error),
        },
      ],
      details: {},
    };
  }
}
