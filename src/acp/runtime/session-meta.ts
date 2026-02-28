import fs from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
import type { SessionAcpMeta } from "../types";

export type AcpSessionStoreEntry = {
  sessionKey: string;
  acp?: SessionAcpMeta;
  storeReadFailed?: boolean;
};

type AcpSessionStore = Record<string, { acp: SessionAcpMeta }>;

const DEFAULT_ACP_SESSIONS_PATH = path.join(homedir(), ".mozi", "acp-sessions.json");

function resolveStorePath(storePath?: string): string {
  return storePath ?? DEFAULT_ACP_SESSIONS_PATH;
}

function readStore(storePath: string): { store: AcpSessionStore; readFailed: boolean } {
  try {
    const raw = fs.readFileSync(storePath, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return { store: parsed as AcpSessionStore, readFailed: false };
    }
    return { store: {}, readFailed: false };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return { store: {}, readFailed: false };
    }
    return { store: {}, readFailed: true };
  }
}

function writeStore(storePath: string, store: AcpSessionStore): void {
  const dir = path.dirname(storePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = `${storePath}.tmp.${process.pid}`;
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(store, null, 2), "utf8");
    fs.renameSync(tmpPath, storePath);
  } catch (err) {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // ignore cleanup errors
    }
    throw err;
  }
}

function resolveStoreKey(store: AcpSessionStore, sessionKey: string): string {
  const normalized = sessionKey.trim();
  if (!normalized) {
    return "";
  }
  if (store[normalized]) {
    return normalized;
  }
  const lower = normalized.toLowerCase();
  if (store[lower]) {
    return lower;
  }
  for (const key of Object.keys(store)) {
    if (key.toLowerCase() === lower) {
      return key;
    }
  }
  return lower;
}

export function readAcpSessionEntry(params: {
  sessionKey: string;
  storePath?: string;
}): AcpSessionStoreEntry | null {
  const sessionKey = params.sessionKey.trim();
  if (!sessionKey) {
    return null;
  }
  const storePath = resolveStorePath(params.storePath);
  const { store, readFailed } = readStore(storePath);
  const storeKey = resolveStoreKey(store, sessionKey);
  const entry = store[storeKey];
  return {
    sessionKey,
    acp: entry?.acp,
    storeReadFailed: readFailed || undefined,
  };
}

export function listAcpSessionEntries(params: {
  storePath?: string;
} = {}): AcpSessionStoreEntry[] {
  const storePath = resolveStorePath(params.storePath);
  const { store, readFailed } = readStore(storePath);
  if (readFailed) {
    return [];
  }
  const entries: AcpSessionStoreEntry[] = [];
  for (const [sessionKey, value] of Object.entries(store)) {
    if (!value?.acp) {
      continue;
    }
    entries.push({
      sessionKey,
      acp: value.acp,
    });
  }
  return entries;
}

export function upsertAcpSessionMeta(params: {
  sessionKey: string;
  storePath?: string;
  mutate: (
    current: SessionAcpMeta | undefined,
  ) => SessionAcpMeta | null | undefined;
}): SessionAcpMeta | null {
  const sessionKey = params.sessionKey.trim();
  if (!sessionKey) {
    return null;
  }
  const storePath = resolveStorePath(params.storePath);
  const { store } = readStore(storePath);
  const storeKey = resolveStoreKey(store, sessionKey) || sessionKey.toLowerCase();
  const current = store[storeKey];
  const nextMeta = params.mutate(current?.acp);

  if (nextMeta === undefined) {
    return current?.acp ?? null;
  }

  if (nextMeta === null) {
    if (current) {
      delete store[storeKey];
      writeStore(storePath, store);
    }
    return null;
  }

  store[storeKey] = { acp: nextMeta };
  writeStore(storePath, store);
  return nextMeta;
}
