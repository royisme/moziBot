export type WidgetRuntimeConfig = {
  enabled: boolean;
  host: string;
  port: number;
  authToken?: string;
  peerId: string;
};

const DEFAULTS: WidgetRuntimeConfig = {
  enabled: true,
  host: "127.0.0.1",
  port: 3987,
  peerId: "desktop-default",
};

export async function loadWidgetConfig(): Promise<WidgetRuntimeConfig> {
  const envEnabled = parseBool(import.meta.env.VITE_WIDGET_ENABLED);
  const envHost = normalizeHost(import.meta.env.VITE_WIDGET_HOST);
  const envPort = normalizePort(import.meta.env.VITE_WIDGET_PORT);
  const envToken = normalizeToken(import.meta.env.VITE_WIDGET_TOKEN);
  const envPeerId = normalizePeerId(import.meta.env.VITE_WIDGET_PEER_ID);

  let runtimeConfig: Partial<WidgetRuntimeConfig> = {};
  try {
    const response = await fetch(`http://${DEFAULTS.host}:${DEFAULTS.port}/widget-config`, {
      cache: "no-store",
    });
    if (response.ok) {
      runtimeConfig = (await response.json()) as Partial<WidgetRuntimeConfig>;
    }
  } catch {
    // runtime may be offline; keep defaults
  }

  const runtimeEnabled =
    typeof runtimeConfig.enabled === "boolean" ? runtimeConfig.enabled : undefined;
  const runtimeHost = normalizeHost(runtimeConfig.host);
  const runtimePort = normalizePort(runtimeConfig.port);
  const runtimeToken = normalizeToken(runtimeConfig.authToken);
  const runtimePeerId = normalizePeerId(runtimeConfig.peerId);

  const enabled = envEnabled ?? runtimeEnabled ?? DEFAULTS.enabled;
  const host = envHost ?? runtimeHost ?? DEFAULTS.host;
  const port = envPort ?? runtimePort ?? DEFAULTS.port;
  const authToken = envToken ?? runtimeToken;
  const peerId = envPeerId ?? runtimePeerId ?? DEFAULTS.peerId;

  return {
    enabled,
    host,
    port,
    authToken,
    peerId,
  };
}

function parseBool(input: unknown): boolean | undefined {
  if (typeof input === "boolean") {
    return input;
  }
  if (typeof input !== "string") {
    return undefined;
  }
  const trimmed = input.trim().toLowerCase();
  if (trimmed === "true" || trimmed === "1" || trimmed === "yes") {
    return true;
  }
  if (trimmed === "false" || trimmed === "0" || trimmed === "no") {
    return false;
  }
  return undefined;
}

function normalizeHost(input: unknown): string | undefined {
  if (typeof input !== "string") {
    return undefined;
  }
  const trimmed = input.trim();
  if (!trimmed) {
    return undefined;
  }
  const lowered = trimmed.toLowerCase();
  if (lowered === "localhost" || lowered === "127.0.0.1" || lowered === "::1") {
    return "127.0.0.1";
  }
  return undefined;
}

function normalizePort(input: unknown): number | undefined {
  const n =
    typeof input === "number" ? input : typeof input === "string" ? Number(input) : Number.NaN;
  if (!Number.isFinite(n) || n <= 0 || n > 65535) {
    return undefined;
  }
  return Math.trunc(n);
}

function normalizeToken(input: unknown): string | undefined {
  if (typeof input !== "string") {
    return undefined;
  }
  const trimmed = input.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizePeerId(input: unknown): string | undefined {
  if (typeof input !== "string") {
    return undefined;
  }
  const trimmed = input.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
