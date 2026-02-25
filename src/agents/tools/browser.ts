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
import {
  normalizeTargetId,
  pickDefaultTarget,
  resolveTargetIdFromTargets,
  type BrowserTarget,
} from "./browser-targets";

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

const WaitForSchema = z
  .object({
    selector: z.string().min(1).optional(),
    selectorState: z.enum(["attached", "visible"]).optional(),
    text: z.string().min(1).optional(),
    textGone: z.string().min(1).optional(),
    url: z.string().min(1).optional(),
    loadState: z.enum(["interactive", "complete"]).optional(),
    timeMs: z.number().int().min(0).optional(),
    timeoutMs: z.number().int().positive().optional(),
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
    waitFor: WaitForSchema.optional(),
  })
  .superRefine((data, ctx) => {
    const selector = data.selector?.trim();
    const url = data.url?.trim();
    const expression = data.expression?.trim();
    const text = data.text;
    const hasCoords = Number.isFinite(data.x) && Number.isFinite(data.y);
    const waitFor = data.waitFor;

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

    if (waitFor) {
      if (data.action === "status" || data.action === "tabs") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["waitFor"],
          message: "waitFor is not supported for status/tabs",
        });
      }
      const hasWaitCondition = Boolean(
        waitFor.selector ||
        waitFor.text ||
        waitFor.textGone ||
        waitFor.url ||
        waitFor.loadState ||
        waitFor.timeMs !== undefined,
      );
      if (!hasWaitCondition) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["waitFor"],
          message:
            "waitFor requires at least one condition (selector/text/textGone/url/loadState/timeMs)",
        });
      }
      if (waitFor.selectorState && !waitFor.selector) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["waitFor", "selectorState"],
          message: "waitFor.selectorState requires waitFor.selector",
        });
      }
    }
  });

export type BrowserToolParams = z.infer<typeof browserToolSchema>;

export type BrowserToolContext = {
  getConfig: () => MoziConfig;
};

type WaitForOptions = z.infer<typeof WaitForSchema>;

type BrowserToolResult = {
  content: Array<{ type: string; text: string }>;
  details: Record<string, unknown>;
};

type ExtensionStatus = { connected: boolean };

type SelectedTarget = {
  targetId: string;
  target: BrowserTarget;
  wsUrl: string;
  headers?: Record<string, string>;
};

type WaitForEvalResult = {
  ok: boolean;
  readyState?: string;
  readyStateOk?: boolean;
  url?: string;
  urlMatch?: boolean;
  selectorFound?: boolean;
  selectorVisible?: boolean;
  textPresent?: boolean;
  textGone?: boolean;
};

type WaitForResult = {
  ok: boolean;
  waitedMs: number;
  timedOut: boolean;
  state?: WaitForEvalResult;
};

const DEFAULT_STATUS_TIMEOUT_MS = 2000;
const DEFAULT_ACTION_TIMEOUT_MS = 15000;
const DEFAULT_NAVIGATE_READY_TIMEOUT_MS = 8000;
const DEFAULT_SCREENSHOT_FORMAT = "png";
const SCREENSHOT_DIR = path.join(process.cwd(), "data", "browser");
const lastTargetByProfile = new Map<string, string>();

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

function resolveWsUrl(baseUrl: string, target?: BrowserTarget): string {
  const fromTarget = target?.webSocketDebuggerUrl?.trim();
  if (fromTarget) {
    return fromTarget;
  }
  const wsBase = baseUrl.replace(/^http:/, "ws:").replace(/^https:/, "wss:");
  return `${wsBase}/cdp`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
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

async function createBlankTarget(opts: {
  baseUrl: string;
  headers?: Record<string, string>;
  timeoutMs: number;
}): Promise<void> {
  const version = await fetchJson<{ webSocketDebuggerUrl?: string }>(
    `${opts.baseUrl}/json/version`,
    {
      headers: opts.headers,
      timeoutMs: opts.timeoutMs,
    },
  );
  const wsUrl = version.webSocketDebuggerUrl?.trim();
  if (!wsUrl) {
    throw new Error("Browser websocket is unavailable for Target.createTarget.");
  }
  const client = await CdpClient.connect(wsUrl, {
    headers: opts.headers,
    timeoutMs: opts.timeoutMs,
  });
  try {
    await client.send("Target.createTarget", { url: "about:blank" }, opts.timeoutMs);
  } finally {
    await client.close();
  }
}

async function resolveTargetForAction(opts: {
  config: MoziConfig;
  profile: BrowserProfile;
  profileName: string;
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

  let targets = await fetchJson<BrowserTarget[]>(`${opts.baseUrl}/json/list`, {
    headers,
    timeoutMs: opts.timeoutMs,
  });
  if (targets.length === 0) {
    if (opts.profile.driver === "extension") {
      throw new Error(
        "Relay is running but no tab is attached. Click the browser extension icon to attach.",
      );
    }
    await createBlankTarget({ baseUrl: opts.baseUrl, headers, timeoutMs: opts.timeoutMs });
    await sleep(200);
    targets = await fetchJson<BrowserTarget[]>(`${opts.baseUrl}/json/list`, {
      headers,
      timeoutMs: opts.timeoutMs,
    });
    if (targets.length === 0) {
      throw new Error("No browser tabs available.");
    }
  }

  let target: BrowserTarget | null = null;
  if (opts.targetId) {
    const resolved = resolveTargetIdFromTargets(opts.targetId, targets);
    if (resolved.ok) {
      target =
        targets.find((candidate) => normalizeTargetId(candidate) === resolved.targetId) ?? null;
    } else if (resolved.reason === "ambiguous") {
      throw new Error("Ambiguous target id prefix.");
    }
    if (!target && targets.length === 1) {
      target = targets[0] ?? null;
    }
    if (!target) {
      throw new Error("Target not found.");
    }
  } else {
    target = pickDefaultTarget(targets, lastTargetByProfile.get(opts.profileName));
    if (!target) {
      throw new Error("Target not found.");
    }
  }

  const resolvedTargetId = normalizeTargetId(target);
  if (!resolvedTargetId) {
    throw new Error("Target id missing from /json/list response.");
  }
  lastTargetByProfile.set(opts.profileName, resolvedTargetId);
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

function buildWaitForScript(waitFor: WaitForOptions): string {
  const selector = waitFor.selector ? JSON.stringify(waitFor.selector) : "null";
  const selectorState = JSON.stringify(waitFor.selectorState ?? "visible");
  const text = waitFor.text ? JSON.stringify(waitFor.text) : "null";
  const textGone = waitFor.textGone ? JSON.stringify(waitFor.textGone) : "null";
  const url = waitFor.url ? JSON.stringify(waitFor.url) : "null";
  const loadState = waitFor.loadState ? JSON.stringify(waitFor.loadState) : "null";

  return `(() => {
  const result = { ok: true, readyState: document.readyState, url: location.href };
  const selector = ${selector};
  const selectorState = ${selectorState};
  if (selector) {
    const el = document.querySelector(selector);
    const found = Boolean(el);
    result.selectorFound = found;
    if (!found) {
      result.ok = false;
    } else if (selectorState === "visible") {
      const style = el ? window.getComputedStyle(el) : null;
      const rect = el ? el.getBoundingClientRect() : null;
      const visible = Boolean(
        el &&
          rect &&
          rect.width > 0 &&
          rect.height > 0 &&
          style &&
          style.visibility !== "hidden" &&
          style.display !== "none" &&
          style.opacity !== "0"
      );
      result.selectorVisible = visible;
      if (!visible) {
        result.ok = false;
      }
    }
  }

  const textNeedle = ${text};
  const textGoneNeedle = ${textGone};
  if (textNeedle || textGoneNeedle) {
    const bodyText = document.body?.innerText || "";
    if (textNeedle) {
      const present = bodyText.includes(textNeedle);
      result.textPresent = present;
      if (!present) {
        result.ok = false;
      }
    }
    if (textGoneNeedle) {
      const gone = !bodyText.includes(textGoneNeedle);
      result.textGone = gone;
      if (!gone) {
        result.ok = false;
      }
    }
  }

  const urlNeedle = ${url};
  if (urlNeedle) {
    const match = String(location.href || "").includes(urlNeedle);
    result.urlMatch = match;
    if (!match) {
      result.ok = false;
    }
  }

  const desiredLoad = ${loadState};
  if (desiredLoad) {
    const ready = document.readyState;
    const ok =
      desiredLoad === "interactive"
        ? ready === "interactive" || ready === "complete"
        : ready === "complete";
    result.readyState = ready;
    result.readyStateOk = ok;
    if (!ok) {
      result.ok = false;
    }
  }

  return result;
})()`;
}

function formatWaitForFailure(state?: WaitForEvalResult): string {
  if (!state) {
    return "condition not met";
  }
  const parts: string[] = [];
  if (state.selectorFound === false) {
    parts.push("selector not found");
  } else if (state.selectorVisible === false) {
    parts.push("selector not visible");
  }
  if (state.textPresent === false) {
    parts.push("text not found");
  }
  if (state.textGone === false) {
    parts.push("text still present");
  }
  if (state.urlMatch === false) {
    parts.push("url not matched");
  }
  if (state.readyStateOk === false) {
    parts.push(`readyState=${state.readyState ?? "unknown"}`);
  }
  return parts.join(", ") || "condition not met";
}

async function waitForDocumentReady(
  client: CdpClient,
  timeoutMs: number,
): Promise<{ state: string; waitedMs: number; timedOut: boolean }> {
  const start = Date.now();
  const deadline = start + Math.max(0, timeoutMs);
  let lastState = "unknown";
  while (Date.now() < deadline) {
    try {
      const evalResult = await client.send(
        "Runtime.evaluate",
        { expression: "document.readyState", returnByValue: true },
        Math.min(1000, timeoutMs),
      );
      const evalError = parseEvalError(evalResult);
      if (!evalError) {
        const record = evalResult as { result?: { value?: string } };
        const state = record.result?.value;
        if (state) {
          lastState = state;
          if (state === "complete") {
            return { state, waitedMs: Date.now() - start, timedOut: false };
          }
        }
      }
    } catch {
      // Ignore transient evaluate failures while the page is still loading.
    }
    await sleep(120);
  }
  return { state: lastState, waitedMs: Date.now() - start, timedOut: true };
}

async function waitForConditions(
  client: CdpClient,
  waitFor: WaitForOptions,
  timeoutMs: number,
): Promise<WaitForResult> {
  const start = Date.now();
  if (waitFor.timeMs && waitFor.timeMs > 0) {
    await sleep(waitFor.timeMs);
  }

  const waitTimeoutMs = waitFor.timeoutMs ?? timeoutMs;
  const deadline = start + Math.max(0, waitTimeoutMs);
  const script = buildWaitForScript(waitFor);
  let lastState: WaitForEvalResult | undefined;

  while (Date.now() < deadline) {
    const evalResult = await client.send(
      "Runtime.evaluate",
      { expression: script, returnByValue: true, awaitPromise: false },
      Math.min(1000, waitTimeoutMs),
    );
    const evalError = parseEvalError(evalResult);
    if (evalError) {
      throw new Error(evalError);
    }
    const record = evalResult as { result?: { value?: WaitForEvalResult } };
    const state = record.result?.value;
    if (state) {
      lastState = state;
      if (state.ok) {
        return { ok: true, waitedMs: Date.now() - start, timedOut: false, state };
      }
    }
    await sleep(150);
  }

  return { ok: false, waitedMs: Date.now() - start, timedOut: true, state: lastState };
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
      profileName: name,
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
      const applyWaitFor = async (): Promise<WaitForResult | null> => {
        if (!params.waitFor) {
          return null;
        }
        const result = await waitForConditions(client, params.waitFor, timeoutMs);
        if (!result.ok) {
          const detail = formatWaitForFailure(result.state);
          throw new Error(detail ? `waitFor timed out (${detail})` : "waitFor timed out");
        }
        return result;
      };

      switch (params.action) {
        case "navigate": {
          const url = params.url?.trim();
          if (!url) {
            throw new Error("url is required");
          }
          const result = await client.send("Page.navigate", { url }, timeoutMs);
          const waitMs = Math.min(DEFAULT_NAVIGATE_READY_TIMEOUT_MS, timeoutMs);
          const readyState = await waitForDocumentReady(client, waitMs);
          const waitForResult = await applyWaitFor();
          const payload = {
            ok: true,
            action: "navigate",
            profile: name,
            targetId: selected.targetId,
            url,
            result,
            readyState: readyState.state,
            waitedMs: readyState.waitedMs,
            timedOut: readyState.timedOut,
            waitFor: waitForResult
              ? { waitedMs: waitForResult.waitedMs, state: waitForResult.state }
              : undefined,
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
          const waitForResult = await applyWaitFor();
          const payload = {
            ok: true,
            action: "evaluate",
            profile: name,
            targetId: selected.targetId,
            value: record.result?.value ?? null,
            type: record.result?.type,
            subtype: record.result?.subtype,
            description: record.result?.description,
            waitFor: waitForResult
              ? { waitedMs: waitForResult.waitedMs, state: waitForResult.state }
              : undefined,
          };
          return wrapBrowserPayload("evaluate", payload, {
            metadata: { profile: name, targetId: selected.targetId },
          });
        }
        case "screenshot": {
          const format = params.screenshot?.format ?? DEFAULT_SCREENSHOT_FORMAT;
          const quality = params.screenshot?.quality;
          const waitForResult = await applyWaitFor();
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
            waitFor: waitForResult
              ? { waitedMs: waitForResult.waitedMs, state: waitForResult.state }
              : undefined,
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
          const waitForResult = await applyWaitFor();
          const payload = {
            ok: true,
            action: "click",
            profile: name,
            targetId: selected.targetId,
            selector: selector ?? undefined,
            x,
            y,
            waitFor: waitForResult
              ? { waitedMs: waitForResult.waitedMs, state: waitForResult.state }
              : undefined,
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
          const waitForResult = await applyWaitFor();
          const payload = {
            ok: true,
            action: "type",
            profile: name,
            targetId: selected.targetId,
            selector: selector ?? undefined,
            textLength: text.length,
            waitFor: waitForResult
              ? { waitedMs: waitForResult.waitedMs, state: waitForResult.state }
              : undefined,
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
