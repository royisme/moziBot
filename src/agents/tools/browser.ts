import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import WebSocket from "ws";
import { z } from "zod";
import type { MoziConfig } from "../../config";
import { ensureChromeExtensionRelayServer } from "../../runtime/browser/extension-relay";
import {
  RELAY_AUTH_HEADER,
  resolveRelayAuthTokenForPort,
} from "../../runtime/browser/extension-relay-auth";
import { detectSuspiciousPatterns, wrapExternalContent } from "../../security/external-content";

type BrowserDriver = "extension" | "cdp";

type BrowserAction = "status" | "tabs" | "navigate" | "evaluate" | "screenshot" | "click" | "type";

type BrowserProfile = {
  driver: BrowserDriver;
  cdpUrl: string;
};

const ScreenshotOptionsSchema = z
  .object({
    format: z.enum(["png", "jpeg"]).optional(),
    quality: z.number().int().min(0).max(100).optional(),
  })
  .strict();

export const browserToolSchema = z
  .object({
    action: z.enum(["status", "tabs", "navigate", "evaluate", "screenshot", "click", "type"]),
    profile: z.string().optional(),
    timeoutMs: z.number().int().positive().optional(),
    targetId: z.string().optional(),
    url: z.string().optional(),
    expression: z.string().optional(),
    selector: z.string().optional(),
    text: z.string().optional(),
    x: z.number().optional(),
    y: z.number().optional(),
    screenshot: ScreenshotOptionsSchema.optional(),
  })
  .superRefine((data, ctx) => {
    const selector = data.selector?.trim();
    const url = data.url?.trim();
    const expression = data.expression?.trim();
    const text = data.text;
    const hasCoords = Number.isFinite(data.x) && Number.isFinite(data.y);

    if (data.action === "navigate" && !url) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["url"], message: "url is required" });
    }

    if (data.action === "evaluate" && !expression) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["expression"],
        message: "expression is required",
      });
    }

    if (data.action === "type" && (!text || text.length === 0)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["text"], message: "text is required" });
    }

    if (data.action === "click" && !selector && !hasCoords) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["selector"],
        message: "selector or x/y coordinates are required",
      });
    }

    if (data.screenshot?.quality !== undefined) {
      const format = data.screenshot?.format ?? "png";
      if (format !== "jpeg") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["screenshot", "quality"],
          message: "screenshot.quality requires format=jpeg",
        });
      }
    }
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

type CdpListTarget = {
  id?: string;
  targetId?: string;
  type?: string;
  title?: string;
  url?: string;
  webSocketDebuggerUrl?: string;
};

type SelectedTarget = {
  targetId: string;
  target: CdpListTarget;
  wsUrl: string;
  headers?: Record<string, string>;
};

const DEFAULT_STATUS_TIMEOUT_MS = 2000;
const DEFAULT_ACTION_TIMEOUT_MS = 15000;
const DEFAULT_SCREENSHOT_FORMAT = "png";
const SCREENSHOT_DIR = path.join(process.cwd(), "data", "browser");

function resolveBrowserProfile(
  config: MoziConfig,
  profileName?: string,
): { name: string; profile: BrowserProfile; relayEnabled: boolean } {
  const browser = config.browser;
  if (browser?.enabled === false) {
    throw new Error("Browser tools are disabled (browser.enabled=false).");
  }
  const profiles = browser?.profiles ?? {};
  let name = profileName ?? browser?.defaultProfile;
  if (!name) {
    const entries = Object.entries(profiles);
    if (entries.length === 1) {
      const [onlyName, onlyProfile] = entries[0];
      return {
        name: onlyName,
        profile: onlyProfile,
        relayEnabled: browser?.relay?.enabled === true,
      };
    }
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

function resolveWsUrl(baseUrl: string, target?: CdpListTarget): string {
  const fromTarget = target?.webSocketDebuggerUrl?.trim();
  if (fromTarget) {
    return fromTarget;
  }
  const wsBase = baseUrl.replace(/^http:/, "ws:").replace(/^https:/, "wss:");
  return `${wsBase}/cdp`;
}

function normalizeTargetId(target: CdpListTarget): string | undefined {
  return target.id ?? target.targetId;
}

function selectTarget(targets: CdpListTarget[], targetId?: string): CdpListTarget {
  if (targets.length === 0) {
    throw new Error("No browser tabs available.");
  }
  if (targetId) {
    const match = targets.find((target) => normalizeTargetId(target) === targetId);
    if (!match) {
      throw new Error(`Target not found: ${targetId}`);
    }
    return match;
  }
  const page = targets.find((target) => (target.type ?? "page") === "page");
  return page ?? targets[0];
}

async function fetchJson<T>(
  url: string,
  opts?: { headers?: Record<string, string>; timeoutMs?: number },
): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    Math.max(1, opts?.timeoutMs ?? DEFAULT_STATUS_TIMEOUT_MS),
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

async function fetchOk(
  url: string,
  opts?: { headers?: Record<string, string>; timeoutMs?: number },
): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    Math.max(1, opts?.timeoutMs ?? DEFAULT_STATUS_TIMEOUT_MS),
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
  } finally {
    clearTimeout(timeout);
  }
}

function wrapBrowserPayload(
  kind: BrowserAction,
  payload: unknown,
  opts?: { includeWarning?: boolean; metadata?: Record<string, string | undefined> },
): BrowserToolResult {
  const rawText = JSON.stringify(payload, null, 2);
  const wrappedText = wrapExternalContent(rawText, {
    source: "browser",
    includeWarning: opts?.includeWarning ?? true,
    metadata: opts?.metadata,
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

function rawDataToString(raw: WebSocket.RawData): string {
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

class CdpClient {
  private ws: WebSocket;
  private nextId = 1;
  private pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
  >();
  private closed = false;

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.on("message", (data) => this.handleMessage(data));
    ws.on("close", () => this.rejectAll(new Error("CDP connection closed")));
    ws.on("error", (err) => this.rejectAll(err instanceof Error ? err : new Error(String(err))));
  }

  static async connect(
    wsUrl: string,
    opts: { headers?: Record<string, string>; timeoutMs: number },
  ): Promise<CdpClient> {
    return await new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl, { headers: opts.headers });
      const timer = setTimeout(
        () => {
          ws.terminate();
          reject(new Error("CDP websocket connection timeout"));
        },
        Math.max(1, opts.timeoutMs),
      );

      ws.once("open", () => {
        clearTimeout(timer);
        resolve(new CdpClient(ws));
      });

      ws.once("error", (err) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      });
    });
  }

  private handleMessage(data: WebSocket.RawData) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawDataToString(data));
    } catch {
      return;
    }
    if (!parsed || typeof parsed !== "object") {
      return;
    }
    const record = parsed as { id?: number; result?: unknown; error?: { message?: string } };
    if (typeof record.id !== "number") {
      return;
    }
    const pending = this.pending.get(record.id);
    if (!pending) {
      return;
    }
    this.pending.delete(record.id);
    clearTimeout(pending.timer);
    if (record.error?.message) {
      pending.reject(new Error(record.error.message));
      return;
    }
    pending.resolve(record.result);
  }

  private rejectAll(error: Error) {
    if (this.closed) {
      return;
    }
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  async send(
    method: string,
    params?: unknown,
    timeoutMs = DEFAULT_ACTION_TIMEOUT_MS,
  ): Promise<unknown> {
    if (this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("CDP websocket is not open");
    }
    const id = this.nextId++;
    const payload = { id, method, params };
    this.ws.send(JSON.stringify(payload));
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => {
          this.pending.delete(id);
          reject(new Error(`CDP timeout: ${method}`));
        },
        Math.max(1, timeoutMs),
      );
      this.pending.set(id, { resolve, reject, timer });
    });
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    await new Promise<void>((resolve) => {
      this.ws.once("close", () => resolve());
      this.ws.close();
      setTimeout(() => resolve(), 200).unref();
    });
  }
}

async function resolveTargetForAction(opts: {
  config: MoziConfig;
  profile: BrowserProfile;
  baseUrl: string;
  timeoutMs: number;
  targetId?: string;
}): Promise<SelectedTarget> {
  let headers: Record<string, string> | undefined;
  if (opts.profile.driver === "extension") {
    headers = await getRelayHeaders(opts.config, opts.profile.cdpUrl);
    const extension = await loadExtensionStatus(opts.baseUrl, opts.timeoutMs).catch(() => ({
      connected: false,
    }));
    if (!extension.connected) {
      throw new Error(
        "Relay is running but no tab is attached. Click the browser extension icon to attach.",
      );
    }
  }

  const targets = await fetchJson<CdpListTarget[]>(`${opts.baseUrl}/json/list`, {
    headers,
    timeoutMs: opts.timeoutMs,
  });
  const target = selectTarget(targets, opts.targetId);
  const resolvedTargetId = normalizeTargetId(target);
  if (!resolvedTargetId) {
    throw new Error("Target id missing from /json/list response.");
  }
  return {
    targetId: resolvedTargetId,
    target,
    wsUrl: resolveWsUrl(opts.baseUrl, target),
    headers,
  };
}

function buildSelectorScript(selector: string, action: "center" | "focus"): string {
  const safeSelector = JSON.stringify(selector);
  if (action === "focus") {
    return `(() => {\n  const el = document.querySelector(${safeSelector});\n  if (!el) return { ok: false, error: "Element not found" };\n  if (typeof el.focus === "function") { el.focus(); }\n  return { ok: true };\n})()`;
  }
  return `(() => {\n  const el = document.querySelector(${safeSelector});\n  if (!el) return { ok: false, error: "Element not found" };\n  if (typeof el.scrollIntoView === "function") {\n    el.scrollIntoView({ block: "center", inline: "center" });\n  }\n  const rect = el.getBoundingClientRect();\n  const x = rect.left + rect.width / 2;\n  const y = rect.top + rect.height / 2;\n  if (!Number.isFinite(x) || !Number.isFinite(y)) {\n    return { ok: false, error: "Invalid element rect" };\n  }\n  return { ok: true, x, y };\n})()`;
}

function parseEvalError(result: unknown): string | null {
  if (!result || typeof result !== "object") {
    return null;
  }
  const record = result as {
    exceptionDetails?: {
      text?: string;
      exception?: { description?: string };
    };
  };
  const details = record.exceptionDetails;
  if (!details) {
    return null;
  }
  return details.text || details.exception?.description || "Runtime.evaluate failed";
}

export async function runBrowserTool(
  ctx: BrowserToolContext,
  params: BrowserToolParams,
): Promise<BrowserToolResult> {
  try {
    const config = ctx.getConfig();
    const { name, profile, relayEnabled } = resolveBrowserProfile(config, params.profile);
    const baseUrl = resolveBaseUrl(profile.cdpUrl);
    const timeoutMs =
      params.action === "status" || params.action === "tabs"
        ? (params.timeoutMs ?? DEFAULT_STATUS_TIMEOUT_MS)
        : (params.timeoutMs ?? DEFAULT_ACTION_TIMEOUT_MS);

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
        return wrapBrowserPayload("status", payload, {
          includeWarning: false,
          metadata: { profile: name },
        });
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
      return wrapBrowserPayload("status", payload, {
        includeWarning: false,
        metadata: { profile: name },
      });
    }

    if (params.action === "tabs") {
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
        return wrapBrowserPayload(
          "tabs",
          { profile: name, driver: profile.driver, tabs },
          {
            metadata: { profile: name },
          },
        );
      }

      const tabs = await fetchJson<unknown[]>(`${baseUrl}/json/list`, { timeoutMs });
      return wrapBrowserPayload(
        "tabs",
        { profile: name, driver: profile.driver, tabs },
        {
          metadata: { profile: name },
        },
      );
    }

    const selected = await resolveTargetForAction({
      config,
      profile,
      baseUrl,
      timeoutMs,
      targetId: params.targetId,
    });

    await fetchOk(`${baseUrl}/json/activate/${encodeURIComponent(selected.targetId)}`, {
      headers: selected.headers,
      timeoutMs,
    }).catch(() => undefined);

    const client = await CdpClient.connect(selected.wsUrl, {
      headers: selected.headers,
      timeoutMs,
    });

    try {
      await client.send("Runtime.enable", undefined, timeoutMs);
      await client.send("Page.enable", undefined, timeoutMs);
      await client.send("Page.bringToFront", undefined, timeoutMs).catch(() => undefined);

      switch (params.action) {
        case "navigate": {
          const url = params.url?.trim();
          if (!url) {
            throw new Error("url is required");
          }
          const result = await client.send("Page.navigate", { url }, timeoutMs);
          const payload = {
            ok: true,
            action: "navigate",
            profile: name,
            targetId: selected.targetId,
            url,
            result,
          };
          return wrapBrowserPayload("navigate", payload, {
            includeWarning: false,
            metadata: { profile: name, targetId: selected.targetId },
          });
        }
        case "evaluate": {
          const expression = params.expression?.trim();
          if (!expression) {
            throw new Error("expression is required");
          }
          const evalResult = await client.send(
            "Runtime.evaluate",
            { expression, returnByValue: true, awaitPromise: true, userGesture: true },
            timeoutMs,
          );
          const evalError = parseEvalError(evalResult);
          if (evalError) {
            throw new Error(evalError);
          }
          const record = evalResult as {
            result?: { value?: unknown; type?: string; subtype?: string; description?: string };
          };
          const payload = {
            ok: true,
            action: "evaluate",
            profile: name,
            targetId: selected.targetId,
            value: record.result?.value ?? null,
            type: record.result?.type,
            subtype: record.result?.subtype,
            description: record.result?.description,
          };
          return wrapBrowserPayload("evaluate", payload, {
            metadata: { profile: name, targetId: selected.targetId },
          });
        }
        case "screenshot": {
          const format = params.screenshot?.format ?? DEFAULT_SCREENSHOT_FORMAT;
          const quality = params.screenshot?.quality;
          const result = await client.send(
            "Page.captureScreenshot",
            {
              format,
              quality: format === "jpeg" ? quality : undefined,
              fromSurface: true,
            },
            timeoutMs,
          );
          const data = (result as { data?: string }).data;
          if (!data) {
            throw new Error("Missing screenshot data");
          }
          await fs.mkdir(SCREENSHOT_DIR, { recursive: true });
          const fileName = `screenshot-${Date.now()}-${randomUUID()}.${format}`;
          const filePath = path.join(SCREENSHOT_DIR, fileName);
          const buffer = Buffer.from(data, "base64");
          await fs.writeFile(filePath, buffer);
          const payload = {
            ok: true,
            action: "screenshot",
            profile: name,
            targetId: selected.targetId,
            path: filePath,
            format,
            bytes: buffer.byteLength,
          };
          return wrapBrowserPayload("screenshot", payload, {
            includeWarning: false,
            metadata: { profile: name, targetId: selected.targetId },
          });
        }
        case "click": {
          let x = params.x;
          let y = params.y;
          const selector = params.selector?.trim();
          if (selector) {
            const evalResult = await client.send(
              "Runtime.evaluate",
              { expression: buildSelectorScript(selector, "center"), returnByValue: true },
              timeoutMs,
            );
            const evalError = parseEvalError(evalResult);
            if (evalError) {
              throw new Error(evalError);
            }
            const record = evalResult as {
              result?: { value?: { ok?: boolean; x?: number; y?: number; error?: string } };
            };
            const value = record.result?.value;
            if (!value?.ok || !Number.isFinite(value.x) || !Number.isFinite(value.y)) {
              throw new Error(value?.error || "Failed to resolve selector coordinates");
            }
            x = value.x;
            y = value.y;
          }
          if (!Number.isFinite(x) || !Number.isFinite(y)) {
            throw new Error("x/y coordinates are required");
          }
          await client.send(
            "Input.dispatchMouseEvent",
            { type: "mouseMoved", x, y, button: "none" },
            timeoutMs,
          );
          await client.send(
            "Input.dispatchMouseEvent",
            { type: "mousePressed", x, y, button: "left", clickCount: 1 },
            timeoutMs,
          );
          await client.send(
            "Input.dispatchMouseEvent",
            { type: "mouseReleased", x, y, button: "left", clickCount: 1 },
            timeoutMs,
          );
          const payload = {
            ok: true,
            action: "click",
            profile: name,
            targetId: selected.targetId,
            selector: selector ?? undefined,
            x,
            y,
          };
          return wrapBrowserPayload("click", payload, {
            includeWarning: false,
            metadata: { profile: name, targetId: selected.targetId },
          });
        }
        case "type": {
          const text = params.text;
          if (!text) {
            throw new Error("text is required");
          }
          const selector = params.selector?.trim();
          if (selector) {
            const evalResult = await client.send(
              "Runtime.evaluate",
              { expression: buildSelectorScript(selector, "focus"), returnByValue: true },
              timeoutMs,
            );
            const evalError = parseEvalError(evalResult);
            if (evalError) {
              throw new Error(evalError);
            }
            const record = evalResult as { result?: { value?: { ok?: boolean; error?: string } } };
            const value = record.result?.value;
            if (!value?.ok) {
              throw new Error(value?.error || "Failed to focus selector");
            }
          }
          await client.send("Input.insertText", { text }, timeoutMs);
          const payload = {
            ok: true,
            action: "type",
            profile: name,
            targetId: selected.targetId,
            selector: selector ?? undefined,
            textLength: text.length,
          };
          return wrapBrowserPayload("type", payload, {
            includeWarning: false,
            metadata: { profile: name, targetId: selected.targetId },
          });
        }
        default:
          throw new Error("Unsupported action");
      }
    } finally {
      await client.close();
    }
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
