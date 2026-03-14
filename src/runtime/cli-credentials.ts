import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CLAUDE_CLI_CREDENTIALS_RELATIVE_PATH = ".claude/.credentials.json";
const CODEX_CLI_AUTH_FILENAME = "auth.json";
const CLAUDE_CLI_KEYCHAIN_SERVICE = "Claude Code-credentials";
const DEFAULT_CACHE_TTL_MS = 5_000;

type CachedValue<T> = {
  value: T | null;
  readAt: number;
  cacheKey: string;
};

let claudeCliCache: CachedValue<ClaudeCliCredential> | null = null;
let codexCliCache: CachedValue<CodexCliCredential> | null = null;

export type ClaudeCliCredential =
  | {
      type: "oauth";
      provider: "anthropic";
      access: string;
      refresh: string;
      expires: number;
    }
  | {
      type: "token";
      provider: "anthropic";
      token: string;
      expires: number;
    };

export type CodexCliCredential = {
  type: "oauth";
  provider: "openai-codex";
  access: string;
  refresh: string;
  expires: number;
  accountId?: string;
};

type ExecFileSyncFn = typeof execFileSync;

function resolveUserPath(input: string): string {
  if (input === "~") {
    return os.homedir();
  }
  if (input.startsWith("~/")) {
    return path.join(os.homedir(), input.slice(2));
  }
  return input;
}

function readJsonFile(filePath: string): unknown {
  try {
    if (!fs.existsSync(filePath)) {
      return null;
    }
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function resolveClaudeCliCredentialsPath(homeDir?: string): string {
  const baseDir = homeDir ?? resolveUserPath("~");
  return path.join(baseDir, CLAUDE_CLI_CREDENTIALS_RELATIVE_PATH);
}

function resolveCodexHomePath(): string {
  const configured = process.env.CODEX_HOME;
  const home = configured ? resolveUserPath(configured) : resolveUserPath("~/.codex");
  try {
    return fs.realpathSync.native(home);
  } catch {
    return home;
  }
}

function resolveCodexCliAuthPath(): string {
  return path.join(resolveCodexHomePath(), CODEX_CLI_AUTH_FILENAME);
}

function computeCodexKeychainAccount(codexHome: string): string {
  const hash = createHash("sha256").update(codexHome).digest("hex");
  return `cli|${hash.slice(0, 16)}`;
}

function parseClaudeCliOauthCredential(claudeOauth: unknown): ClaudeCliCredential | null {
  if (!claudeOauth || typeof claudeOauth !== "object") {
    return null;
  }
  const data = claudeOauth as Record<string, unknown>;
  const accessToken = data.accessToken;
  const refreshToken = data.refreshToken;
  const expiresAt = data.expiresAt;

  if (typeof accessToken !== "string" || !accessToken) {
    return null;
  }
  if (typeof expiresAt !== "number" || !Number.isFinite(expiresAt) || expiresAt <= 0) {
    return null;
  }
  if (typeof refreshToken === "string" && refreshToken) {
    return {
      type: "oauth",
      provider: "anthropic",
      access: accessToken,
      refresh: refreshToken,
      expires: expiresAt,
    };
  }
  return {
    type: "token",
    provider: "anthropic",
    token: accessToken,
    expires: expiresAt,
  };
}

function readClaudeCliKeychainCredentials(
  execFileSyncImpl: ExecFileSyncFn = execFileSync,
): ClaudeCliCredential | null {
  if (process.platform !== "darwin") {
    return null;
  }
  try {
    const result = execFileSyncImpl(
      "security",
      ["find-generic-password", "-s", CLAUDE_CLI_KEYCHAIN_SERVICE, "-w"],
      { encoding: "utf8", timeout: 5000, stdio: ["pipe", "pipe", "pipe"] },
    );
    const data = JSON.parse(result.trim()) as Record<string, unknown>;
    return parseClaudeCliOauthCredential(data.claudeAiOauth);
  } catch {
    return null;
  }
}

function readClaudeCliCredentialsUncached(options?: {
  allowKeychainPrompt?: boolean;
  homeDir?: string;
  execFileSync?: ExecFileSyncFn;
}): ClaudeCliCredential | null {
  if (process.platform === "darwin" && options?.allowKeychainPrompt !== false) {
    const keychainCreds = readClaudeCliKeychainCredentials(options?.execFileSync);
    if (keychainCreds) {
      return keychainCreds;
    }
  }

  const credPath = resolveClaudeCliCredentialsPath(options?.homeDir);
  const raw = readJsonFile(credPath);
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const data = raw as Record<string, unknown>;
  return parseClaudeCliOauthCredential(data.claudeAiOauth);
}

function readCodexKeychainCredentials(
  execFileSyncImpl: ExecFileSyncFn = execFileSync,
): CodexCliCredential | null {
  if (process.platform !== "darwin") {
    return null;
  }

  const codexHome = resolveCodexHomePath();
  const account = computeCodexKeychainAccount(codexHome);

  try {
    const secret = execFileSyncImpl(
      "security",
      ["find-generic-password", "-s", "Codex Auth", "-a", account, "-w"],
      { encoding: "utf8", timeout: 5000, stdio: ["pipe", "pipe", "pipe"] },
    ).trim();

    const parsed = JSON.parse(secret) as Record<string, unknown>;
    const tokens = parsed.tokens as Record<string, unknown> | undefined;
    const accessToken = tokens?.access_token;
    const refreshToken = tokens?.refresh_token;
    if (typeof accessToken !== "string" || !accessToken) {
      return null;
    }
    if (typeof refreshToken !== "string" || !refreshToken) {
      return null;
    }

    const lastRefreshRaw = parsed.last_refresh;
    const lastRefresh =
      typeof lastRefreshRaw === "string" || typeof lastRefreshRaw === "number"
        ? new Date(lastRefreshRaw).getTime()
        : Date.now();
    const expires = Number.isFinite(lastRefresh)
      ? lastRefresh + 60 * 60 * 1000
      : Date.now() + 60 * 60 * 1000;

    return {
      type: "oauth",
      provider: "openai-codex",
      access: accessToken,
      refresh: refreshToken,
      expires,
      accountId: typeof tokens?.account_id === "string" ? tokens.account_id : undefined,
    };
  } catch {
    return null;
  }
}

function readCodexCliCredentialsUncached(options?: {
  execFileSync?: ExecFileSyncFn;
}): CodexCliCredential | null {
  const keychain = readCodexKeychainCredentials(options?.execFileSync);
  if (keychain) {
    return keychain;
  }

  const authPath = resolveCodexCliAuthPath();
  const raw = readJsonFile(authPath);
  if (!raw || typeof raw !== "object") {
    return null;
  }

  const data = raw as Record<string, unknown>;
  const tokens = data.tokens as Record<string, unknown> | undefined;
  if (!tokens || typeof tokens !== "object") {
    return null;
  }

  const accessToken = tokens.access_token;
  const refreshToken = tokens.refresh_token;
  if (typeof accessToken !== "string" || !accessToken) {
    return null;
  }
  if (typeof refreshToken !== "string" || !refreshToken) {
    return null;
  }

  let expires: number;
  try {
    expires = fs.statSync(authPath).mtimeMs + 60 * 60 * 1000;
  } catch {
    expires = Date.now() + 60 * 60 * 1000;
  }

  return {
    type: "oauth",
    provider: "openai-codex",
    access: accessToken,
    refresh: refreshToken,
    expires,
    accountId: typeof tokens.account_id === "string" ? tokens.account_id : undefined,
  };
}

function readCached<T>(
  cache: CachedValue<T> | null,
  cacheKey: string,
  ttlMs: number,
  read: () => T | null,
): CachedValue<T> {
  const now = Date.now();
  if (cache && cache.cacheKey === cacheKey && now - cache.readAt < ttlMs) {
    return cache;
  }
  return { value: read(), readAt: now, cacheKey };
}

export function resetCliCredentialCachesForTest(): void {
  claudeCliCache = null;
  codexCliCache = null;
}

export function readClaudeCliCredentials(options?: {
  allowKeychainPrompt?: boolean;
  homeDir?: string;
  ttlMs?: number;
  execFileSync?: ExecFileSyncFn;
}): ClaudeCliCredential | null {
  const ttlMs = options?.ttlMs ?? DEFAULT_CACHE_TTL_MS;
  const cacheKey = `${process.platform}|${resolveClaudeCliCredentialsPath(options?.homeDir)}`;
  claudeCliCache = readCached(claudeCliCache, cacheKey, ttlMs, () =>
    readClaudeCliCredentialsUncached(options),
  );
  return claudeCliCache.value;
}

export function readCodexCliCredentials(options?: {
  ttlMs?: number;
  execFileSync?: ExecFileSyncFn;
}): CodexCliCredential | null {
  const ttlMs = options?.ttlMs ?? DEFAULT_CACHE_TTL_MS;
  const cacheKey = `${process.platform}|${resolveCodexCliAuthPath()}`;
  codexCliCache = readCached(codexCliCache, cacheKey, ttlMs, () =>
    readCodexCliCredentialsUncached(options),
  );
  return codexCliCache.value;
}
