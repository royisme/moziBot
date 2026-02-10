import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

const BLOCKED_ENV_KEYS = new Set([
  "PATH",
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "DYLD_INSERT_LIBRARIES",
  "DYLD_LIBRARY_PATH",
  "NODE_OPTIONS",
  "BUN_OPTIONS",
]);

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_BUFFER = 4 * 1024 * 1024;

export type HostExecParams = {
  workspaceDir: string;
  command: string;
  env?: Record<string, string>;
  cwd?: string;
  allowlist?: string[];
};

export async function hostExec(params: HostExecParams): Promise<{
  stdout: string;
  stderr: string;
  exitCode: number;
}> {
  const command = params.command?.trim();
  if (!command) {
    throw new Error("command required");
  }

  if (params.allowlist && params.allowlist.length > 0) {
    const commands = extractCommandNames(command);
    if (commands.length === 0) {
      throw new Error("unable to resolve command");
    }
    const disallowed = commands.find((cmd) => !params.allowlist?.includes(cmd));
    if (disallowed) {
      throw new Error(`command not allowed: ${disallowed}`);
    }
  }

  const workspaceRoot = path.resolve(params.workspaceDir);
  const resolvedCwd = resolveCwd(workspaceRoot, params.cwd);

  const env = buildSafeEnv(params.env);

  try {
    const { stdout, stderr } = await exec("/bin/sh", ["-lc", command], {
      cwd: resolvedCwd,
      env,
      timeout: DEFAULT_TIMEOUT_MS,
      maxBuffer: DEFAULT_MAX_BUFFER,
    });
    return {
      stdout: stdout?.toString() ?? "",
      stderr: stderr?.toString() ?? "",
      exitCode: 0,
    };
  } catch (error) {
    const err = error as NodeJS.ErrnoException & {
      stdout?: string | Buffer;
      stderr?: string | Buffer;
      code?: number;
    };
    return {
      stdout: err.stdout?.toString() ?? "",
      stderr: err.stderr?.toString() ?? err.message ?? "exec failed",
      exitCode: typeof err.code === "number" ? err.code : 1,
    };
  }
}

function resolveCwd(workspaceRoot: string, cwd?: string): string {
  const base = workspaceRoot;
  const target = cwd ? path.resolve(path.isAbsolute(cwd) ? cwd : path.join(base, cwd)) : base;
  const rel = path.relative(base, target);
  if (rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))) {
    return target;
  }
  throw new Error("cwd must be within workspace");
}

function extractCommandNames(command: string): string[] {
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

function splitCommandSegments(command: string): string[] {
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

function extractFirstCommandName(segment: string): string | null {
  let rest = segment.trim();
  if (!rest) {
    return null;
  }

  while (true) {
    const envMatch = /^([A-Za-z_][A-Za-z0-9_]*)=(?:"[^"]*"|'[^']*'|[^\s]+)\s+/.exec(rest);
    if (!envMatch) {
      break;
    }
    rest = rest.slice(envMatch[0].length);
  }

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

function buildSafeEnv(override?: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") {
      env[key] = value;
    }
  }

  if (!override) {
    return env;
  }

  for (const [key, value] of Object.entries(override)) {
    const upper = key.toUpperCase();
    if (BLOCKED_ENV_KEYS.has(upper)) {
      throw new Error(`env ${key} is not allowed`);
    }
    env[key] = value;
  }

  return env;
}
