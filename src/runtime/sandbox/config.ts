import path from "node:path";
import type { SandboxConfig } from "./types.js";

/**
 * SandboxBoundary defines the execution boundaries for a sandbox environment.
 * This is a pure configuration interface - no execution logic.
 */
export interface SandboxBoundary {
  /** The workspace directory that processes are restricted to */
  workspaceDir: string;
  /** Optional allowlist of allowed commands */
  allowlist?: string[];
  /** Optional list of environment variable keys to block */
  blockedEnvKeys?: string[];
  /** The sandbox execution mode */
  mode: "off" | "docker" | "apple-vm" | "vibebox";
}

/**
 * Default set of blocked environment variable keys for security.
 */
export const BLOCKED_ENV_KEYS = new Set([
  "PATH",
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "DYLD_INSERT_LIBRARIES",
  "DYLD_LIBRARY_PATH",
  "NODE_OPTIONS",
  "BUN_OPTIONS",
]);

/**
 * Resolve the current working directory within the sandbox boundary.
 * Validates that the cwd is within the workspace directory.
 *
 * @param boundary - The sandbox boundary configuration
 * @param cwd - Optional cwd to resolve (relative to workspace or absolute)
 * @returns The resolved absolute cwd path
 * @throws Error if cwd is outside the workspace
 */
export function resolveCwd(boundary: SandboxBoundary, cwd?: string): string {
  const base = path.resolve(boundary.workspaceDir);
  const target = cwd ? path.resolve(path.isAbsolute(cwd) ? cwd : path.join(base, cwd)) : base;
  const rel = path.relative(base, target);
  if (rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))) {
    return target;
  }
  throw new Error("cwd must be within workspace");
}

/**
 * Build a safe environment by filtering blocked env keys.
 *
 * @param boundary - The sandbox boundary configuration
 * @param override - Optional environment variables to add/override
 * @returns A filtered environment object
 * @throws Error if override contains blocked env keys
 */
export function buildSafeEnv(
  boundary: SandboxBoundary,
  override?: Record<string, string>,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") {
      env[key] = value;
    }
  }

  if (!override) {
    return env;
  }

  const blockedKeys = new Set(
    (boundary.blockedEnvKeys ?? Array.from(BLOCKED_ENV_KEYS)).map((k) => k.toUpperCase()),
  );

  for (const [key, value] of Object.entries(override)) {
    const upper = key.toUpperCase();
    if (blockedKeys.has(upper)) {
      throw new Error(`env ${key} is not allowed`);
    }
    env[key] = value;
  }

  return env;
}

/**
 * Validate a command against an optional allowlist.
 * Extracts command names from the command string and checks against the allowlist.
 *
 * @param command - The command string to validate
 * @param allowlist - Optional list of allowed command names
 * @returns Result object with ok: true or ok: false with reason
 */
export function validateCommand(
  command: string,
  allowlist?: string[],
): { ok: true } | { ok: false; reason: string } {
  if (!allowlist || allowlist.length === 0) {
    return { ok: true };
  }

  const commands = extractCommandNames(command);
  if (commands.length === 0) {
    return { ok: false, reason: "unable to resolve command" };
  }

  const disallowed = commands.find((cmd) => !allowlist.includes(cmd));
  if (disallowed) {
    return { ok: false, reason: `command not allowed: ${disallowed}` };
  }

  return { ok: true };
}

/**
 * Extract all command names from a command string.
 * Handles pipes, semicolons, &&, ||, and other shell operators.
 *
 * @param command - The command string to parse
 * @returns Array of command names found
 */
export function extractCommandNames(command: string): string[] {
  const segments = splitCommandSegments(command);
  const names: string[] = [];

  for (const segment of segments) {
    const name = extractFirstCommandName(segment);
    if (name) {
      names.push(name);
    }
  }

  return names;
}

/**
 * Split a command string into segments based on shell operators.
 * Handles &&, ||, ;, |, &, and newlines.
 *
 * @param command - The command string to split
 * @returns Array of command segments
 */
export function splitCommandSegments(command: string): string[] {
  const segments: string[] = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;
  let escaped = false;

  const pushCurrent = () => {
    const trimmed = current.trim();
    if (trimmed) {
      segments.push(trimmed);
    }
    current = "";
  };

  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i];

    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }

    if (ch === "\\") {
      current += ch;
      escaped = true;
      continue;
    }

    if (!inDouble && ch === "'") {
      inSingle = !inSingle;
      current += ch;
      continue;
    }

    if (!inSingle && ch === '"') {
      inDouble = !inDouble;
      current += ch;
      continue;
    }

    if (!inSingle && !inDouble) {
      const next = command[i + 1];
      if ((ch === "&" && next === "&") || (ch === "|" && next === "|")) {
        pushCurrent();
        i += 1;
        continue;
      }
      if (ch === ";" || ch === "|" || ch === "&" || ch === "\n") {
        pushCurrent();
        continue;
      }
    }

    current += ch;
  }

  pushCurrent();
  return segments;
}

/**
 * Extract the first command name from a command segment.
 * Strips leading environment variable assignments and returns the base name.
 *
 * @param segment - The command segment to parse
 * @returns The command name or null if none found
 */
export function extractFirstCommandName(segment: string): string | null {
  let rest = segment.trim();
  if (!rest) {
    return null;
  }

  // Skip environment variable assignments at the beginning
  while (true) {
    const envMatch = /^([A-Za-z_][A-Za-z0-9_]*)=(?:"[^"]*"|'[^']*'|[^\s]+)\s+/.exec(rest);
    if (!envMatch) {
      break;
    }
    rest = rest.slice(envMatch[0].length);
  }

  // Extract the first token (command name)
  const tokenMatch = /^("([^"]+)"|'([^']+)'|([^\s]+))/.exec(rest);
  if (!tokenMatch) {
    return null;
  }
  const token = tokenMatch[2] || tokenMatch[3] || tokenMatch[4];
  if (!token) {
    return null;
  }
  return path.basename(token);
}

/**
 * Create a SandboxBoundary from a SandboxConfig.
 * This is a factory function that adapts the existing SandboxConfig to the new SandboxBoundary interface.
 *
 * @param workspaceDir - The workspace directory (required — most security-critical field)
 * @param config - Optional SandboxConfig
 * @param allowlist - Optional command allowlist
 * @returns A SandboxBoundary instance
 */
export function createSandboxBoundary(
  workspaceDir: string,
  config?: SandboxConfig,
  allowlist?: string[],
): SandboxBoundary {
  const mode = config?.mode ?? "off";

  // Detect vibebox configuration: mode is 'vibebox' when the apple backend is
  // explicitly set to vibebox, or when vibebox is explicitly enabled.
  const vibeboxEnabled =
    config?.apple?.backend === "vibebox" || config?.apple?.vibebox?.enabled === true;

  const effectiveMode: SandboxBoundary["mode"] = vibeboxEnabled
    ? "vibebox"
    : (mode as SandboxBoundary["mode"]);

  return {
    workspaceDir,
    allowlist,
    blockedEnvKeys: Array.from(BLOCKED_ENV_KEYS),
    mode: effectiveMode,
  };
}
