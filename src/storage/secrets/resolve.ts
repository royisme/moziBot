import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse as parseDotEnv } from "dotenv";
import { isSecretRef, normalizeSecretInputString, type SecretInput, type SecretRef } from "./types";

/**
 * Resolve a SecretInput to its plaintext string value.
 *
 * - Plain string → returned as-is (including `${ENV_VAR}` templates which
 *   are resolved by expanding the env var name from the template).
 * - SecretRef with source "env" → reads `process.env[ref.id]`.
 * - SecretRef with source "file" or "exec" → warns and returns undefined
 *   until those sources are implemented.
 */
function readSharedEnvSecret(key: string): string | undefined {
  try {
    const envFilePath = path.join(os.homedir(), ".mozi", ".env");
    const raw = fs.readFileSync(envFilePath, "utf8");
    const parsed = parseDotEnv(raw);
    const value = parsed[key];
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

export function resolveSecretInput(
  input: SecretInput | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (input === undefined || input === null) {
    return undefined;
  }

  // Plain string path
  if (typeof input === "string") {
    // Expand ${ENV_VAR} template strings
    const templateMatch = input.match(/^\$\{([A-Z][A-Z0-9_]*)\}$/);
    if (templateMatch?.[1]) {
      const value = env[templateMatch[1]];
      return value?.trim() || readSharedEnvSecret(templateMatch[1]);
    }
    return normalizeSecretInputString(input);
  }

  // SecretRef path
  if (isSecretRef(input)) {
    return resolveSecretRef(input, env);
  }

  return undefined;
}

function resolveSecretRef(ref: SecretRef, env: NodeJS.ProcessEnv): string | undefined {
  switch (ref.source) {
    case "env": {
      const value = env[ref.id];
      return value?.trim() || undefined;
    }
    case "file":
      console.warn(
        `SecretRef source "file" is not yet supported and will be ignored (ref: ${ref.provider}/${ref.id}).`,
      );
      return undefined;
    case "exec":
      console.warn(
        `SecretRef source "exec" is not yet supported and will be ignored (ref: ${ref.provider}/${ref.id}).`,
      );
      return undefined;
    default:
      throw new Error(`Unknown SecretRef source: ${String((ref as { source: unknown }).source)}`);
  }
}
