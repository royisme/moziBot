import type { AcpServerOptions } from "./types";

export type AcpSessionMeta = {
  sessionKey?: string;
  sessionLabel?: string;
  resetSession?: boolean;
  requireExisting?: boolean;
  prefixCwd?: boolean;
};

function readString(
  meta: Record<string, unknown> | null | undefined,
  keys: string[],
): string | undefined {
  if (!meta) {
    return undefined;
  }
  for (const key of keys) {
    const value = meta[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function readBool(
  meta: Record<string, unknown> | null | undefined,
  keys: string[],
): boolean | undefined {
  if (!meta) {
    return undefined;
  }
  for (const key of keys) {
    const value = meta[key];
    if (typeof value === "boolean") {
      return value;
    }
  }
  return undefined;
}

export function parseSessionMeta(meta: unknown): AcpSessionMeta {
  if (!meta || typeof meta !== "object") {
    return {};
  }
  const record = meta as Record<string, unknown>;
  return {
    sessionKey: readString(record, ["sessionKey", "session", "key"]),
    sessionLabel: readString(record, ["sessionLabel", "label"]),
    resetSession: readBool(record, ["resetSession", "reset"]),
    requireExisting: readBool(record, ["requireExistingSession", "requireExisting"]),
    prefixCwd: readBool(record, ["prefixCwd"]),
  };
}

/**
 * Resolves the session key to use for an ACP session.
 *
 * In moziBot, sessions are local — there is no remote gateway to resolve labels
 * against. We resolve in priority order:
 *   1. session key from meta (if present and not requireExisting, use directly)
 *   2. session label from meta (passed to adapter.resolveSessionKey if provided)
 *   3. defaults from opts
 *   4. fallback key
 *
 * For label resolution, the adapter's resolveSessionKey is used if provided.
 */
export async function resolveSessionKey(params: {
  meta: AcpSessionMeta;
  fallbackKey: string;
  opts: AcpServerOptions;
  adapter?: {
    resolveSessionKey(params: { key?: string; label?: string }): Promise<string | null>;
  };
}): Promise<string> {
  const { meta, fallbackKey, opts, adapter } = params;
  const requestedLabel = meta.sessionLabel ?? opts.defaultSessionLabel;
  const requestedKey = meta.sessionKey ?? opts.defaultSessionKey;
  const requireExisting = meta.requireExisting ?? opts.requireExistingSession ?? false;

  if (meta.sessionLabel) {
    if (adapter) {
      const resolved = await adapter.resolveSessionKey({ label: meta.sessionLabel });
      if (!resolved) {
        throw new Error(`Unable to resolve session label: ${meta.sessionLabel}`);
      }
      return resolved;
    }
    throw new Error(`Unable to resolve session label: ${meta.sessionLabel} (no adapter)`);
  }

  if (meta.sessionKey) {
    if (!requireExisting) {
      return meta.sessionKey;
    }
    if (adapter) {
      const resolved = await adapter.resolveSessionKey({ key: meta.sessionKey });
      if (!resolved) {
        throw new Error(`Session key not found: ${meta.sessionKey}`);
      }
      return resolved;
    }
    return meta.sessionKey;
  }

  if (requestedLabel) {
    if (adapter) {
      const resolved = await adapter.resolveSessionKey({ label: requestedLabel });
      if (!resolved) {
        throw new Error(`Unable to resolve session label: ${requestedLabel}`);
      }
      return resolved;
    }
    throw new Error(`Unable to resolve session label: ${requestedLabel} (no adapter)`);
  }

  if (requestedKey) {
    if (!requireExisting) {
      return requestedKey;
    }
    if (adapter) {
      const resolved = await adapter.resolveSessionKey({ key: requestedKey });
      if (!resolved) {
        throw new Error(`Session key not found: ${requestedKey}`);
      }
      return resolved;
    }
    return requestedKey;
  }

  return fallbackKey;
}

/**
 * Resets a session via the adapter if requested by meta or opts.
 * Calls onReset callback when a reset is needed.
 */
export async function resetSessionIfNeeded(params: {
  meta: AcpSessionMeta;
  sessionKey: string;
  opts: AcpServerOptions;
  onReset?: (sessionKey: string) => Promise<void>;
}): Promise<void> {
  const resetSession = params.meta.resetSession ?? params.opts.resetSession ?? false;
  if (!resetSession) {
    return;
  }
  if (params.onReset) {
    await params.onReset(params.sessionKey);
  }
}
