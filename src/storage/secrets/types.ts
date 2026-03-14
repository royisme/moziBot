import { z } from "zod";

// ---------------------------------------------------------------------------
// SecretRef — portable reference to a secret stored in an external source
// ---------------------------------------------------------------------------

export const SECRET_REF_SOURCES = ["env", "file", "exec"] as const;

export type SecretRefSource = (typeof SECRET_REF_SOURCES)[number];

/**
 * Stable identifier for a secret in a configured source.
 * - env source:  provider "default", id "OPENAI_API_KEY"
 * - file source: provider "mounted-json", id "/providers/openai/apiKey"
 * - exec source: provider "vault", id "openai/api-key"
 */
export type SecretRef = {
  source: SecretRefSource;
  provider: string;
  id: string;
};

/**
 * A secret value can be either a plaintext string or a reference to an
 * externally-managed secret.
 */
export type SecretInput = string | SecretRef;

export const DEFAULT_SECRET_PROVIDER_ALIAS = "default";
export const ENV_SECRET_REF_ID_RE = /^[A-Z][A-Z0-9_]{0,127}$/;

// ---------------------------------------------------------------------------
// Zod schemas for config validation
// ---------------------------------------------------------------------------

export const SecretRefSchema = z.object({
  source: z.enum(SECRET_REF_SOURCES),
  provider: z.string().min(1),
  id: z.string().min(1),
});

/**
 * Accepts either a plain string or a structured SecretRef object.
 * Plain `${ENV_VAR}` template strings remain plain strings; they are resolved
 * at runtime, not during config parsing.
 */
export const SecretInputSchema = z.union([z.string(), SecretRefSchema]);

// ---------------------------------------------------------------------------
// Helper functions
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isSecretRef(value: unknown): value is SecretRef {
  if (!isRecord(value)) {
    return false;
  }
  return (
    SECRET_REF_SOURCES.includes(value.source as SecretRefSource) &&
    typeof value.provider === "string" &&
    typeof value.id === "string"
  );
}

/** Returns the plaintext string value if `value` is a non-empty string, else undefined. */
export function normalizeSecretInputString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** Returns true if the value is a non-empty string or a valid SecretRef. */
export function hasConfiguredSecretInput(value: unknown): boolean {
  if (normalizeSecretInputString(value)) {
    return true;
  }
  return isSecretRef(value);
}

/**
 * Attempt to coerce an unknown value into a SecretRef.
 * Handles structured refs, and `${ENV_VAR}` template strings (coerced to env refs).
 */
export function coerceSecretRef(value: unknown): SecretRef | null {
  if (isSecretRef(value)) {
    return value;
  }

  // Parse ${ENV_VAR} template strings as env secret refs
  if (typeof value === "string") {
    const match = value.match(/^\$\{([A-Z][A-Z0-9_]{0,127})\}$/);
    if (match?.[1]) {
      return {
        source: "env",
        provider: DEFAULT_SECRET_PROVIDER_ALIAS,
        id: match[1],
      };
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Secret storage interfaces (unchanged)
// ---------------------------------------------------------------------------

export type SecretScope =
  | {
      type: "global";
    }
  | {
      type: "agent";
      agentId: string;
    };

export interface SecretManager {
  get(key: string, scope?: SecretScope): Promise<string | undefined>;
  getEffective(key: string, agentId?: string): Promise<string | undefined>;
  set(key: string, value: string, scope?: SecretScope): Promise<void>;
  delete(key: string, scope?: SecretScope): Promise<void>;
  list(scope?: SecretScope): Promise<string[]>;
  has(key: string, scope?: SecretScope): Promise<boolean>;
}

export interface SecretBackend {
  get(key: string, scope: SecretScope): Promise<string | undefined>;
  set(key: string, value: string, scope: SecretScope): Promise<void>;
  delete(key: string, scope: SecretScope): Promise<void>;
  list(scope: SecretScope): Promise<string[]>;
  has(key: string, scope: SecretScope): Promise<boolean>;
}
