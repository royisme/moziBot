import net from "node:net";
import { z } from "zod";

const BrowserDriverSchema = z.enum(["extension", "cdp"]);

const BrowserProfileSchema = z
  .object({
    driver: BrowserDriverSchema,
    cdpUrl: z.string().min(1),
  })
  .strict();

const BrowserRelayConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    bindHost: z.string().min(1).optional(),
    port: z.number().int().positive().max(65535).optional(),
    authToken: z.string().min(1).optional(),
  })
  .strict();

function isLoopbackAddress(raw: string): boolean {
  const value = raw.trim().toLowerCase();
  if (!value) {
    return false;
  }
  if (value === "::1") {
    return true;
  }
  if (value.startsWith("::ffff:")) {
    const mapped = value.slice("::ffff:".length);
    return mapped.startsWith("127.");
  }
  if (net.isIP(value) === 4) {
    return value.startsWith("127.");
  }
  if (net.isIP(value) === 6) {
    return value === "::1";
  }
  return false;
}

function isLoopbackHost(host: string): boolean {
  const value = host.trim().toLowerCase();
  if (!value) {
    return false;
  }
  if (value === "localhost") {
    return true;
  }
  if (value.startsWith("[") && value.endsWith("]")) {
    return isLoopbackAddress(value.slice(1, -1));
  }
  return isLoopbackAddress(value);
}

function parseHttpUrl(value: string): URL | null {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function parsePort(parsed: URL): number | null {
  const raw = parsed.port?.trim();
  const port = raw && raw !== "" ? Number(raw) : parsed.protocol === "https:" ? 443 : 80;
  if (!Number.isFinite(port) || port <= 0 || port > 65535) {
    return null;
  }
  return port;
}

function validateLoopbackCdpUrl(
  cdpUrl: string,
  ctx: z.RefinementCtx,
  path: (string | number)[],
  driver: "extension" | "cdp",
) {
  const parsed = parseHttpUrl(cdpUrl);
  if (!parsed) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path,
      message: `${driver} cdpUrl must be an http(s) URL`,
    });
    return;
  }

  if (!parsed.port) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path,
      message: `${driver} cdpUrl must include an explicit port`,
    });
    return;
  }

  if (!isLoopbackHost(parsed.hostname)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path,
      message: `${driver} cdpUrl must use a loopback host (localhost/127.0.0.1/::1)`,
    });
  }
}

export const BrowserConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    profiles: z.record(z.string(), BrowserProfileSchema).optional(),
    defaultProfile: z.string().optional(),
    relay: BrowserRelayConfigSchema.optional(),
  })
  .strict()
  .superRefine((browser, ctx) => {
    const profiles = browser.profiles ?? {};
    for (const [name, profile] of Object.entries(profiles)) {
      const path = ["profiles", name, "cdpUrl"];
      validateLoopbackCdpUrl(profile.cdpUrl, ctx, path, profile.driver);
    }

    if (browser.defaultProfile && !profiles[browser.defaultProfile]) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["defaultProfile"],
        message: `defaultProfile must reference an existing browser profile`,
      });
    }

    const relay = browser.relay;
    if (relay?.bindHost && !isLoopbackHost(relay.bindHost)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["relay", "bindHost"],
        message: "relay.bindHost must be a loopback host (localhost/127.0.0.1/::1)",
      });
    }

    if (relay?.enabled && relay.port) {
      for (const [name, profile] of Object.entries(profiles)) {
        if (profile.driver !== "extension") {
          continue;
        }
        const parsed = parseHttpUrl(profile.cdpUrl);
        const port = parsed ? parsePort(parsed) : null;
        if (port && port !== relay.port) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["profiles", name, "cdpUrl"],
            message: `extension profile cdpUrl port must match relay.port (${relay.port})`,
          });
        }
      }
    }
  });

export type BrowserConfig = z.infer<typeof BrowserConfigSchema>;
