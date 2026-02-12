import fs from "node:fs";
import { promises as fsp } from "node:fs";
import path from "node:path";
import { hashConfigRaw } from "./snapshot";

const DEFAULT_BACKUP_LIMIT = 5;

export interface WriteConfigRawOptions {
  expectedRawHash?: string;
  backupLimit?: number;
}

export class ConfigConflictError extends Error {
  readonly code = "CONFIG_CONFLICT";
}

async function fsyncFile(filePath: string): Promise<void> {
  const handle = await fsp.open(filePath, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function fsyncDirectory(dirPath: string): Promise<void> {
  const handle = await fsp.open(dirPath, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function pruneBackups(configPath: string, limit: number): Promise<void> {
  if (limit <= 0) {
    return;
  }
  const dir = path.dirname(configPath);
  const base = path.basename(configPath);
  const entries = await fsp.readdir(dir);
  const backups = entries
    .filter((name) => name.startsWith(`${base}.bak.`))
    .map((name) => ({
      name,
      ts: Number.parseInt(name.slice(`${base}.bak.`.length), 10),
    }))
    .filter((entry) => Number.isFinite(entry.ts))
    .toSorted((a, b) => b.ts - a.ts);

  for (const old of backups.slice(limit)) {
    await fsp.unlink(path.join(dir, old.name)).catch(() => {});
  }
}

export async function writeConfigRawAtomic(
  configPath: string,
  raw: string,
  options: WriteConfigRawOptions = {},
): Promise<{ rawHash: string; backupPath: string | null }> {
  const dir = path.dirname(configPath);
  const backupLimit = options.backupLimit ?? DEFAULT_BACKUP_LIMIT;
  await fsp.mkdir(dir, { recursive: true });

  const currentRaw = fs.existsSync(configPath) ? await fsp.readFile(configPath, "utf-8") : null;
  const currentHash = hashConfigRaw(currentRaw);
  if (options.expectedRawHash && options.expectedRawHash !== currentHash) {
    throw new ConfigConflictError(
      `Config changed since last read (expected ${options.expectedRawHash}, found ${currentHash})`,
    );
  }

  let backupPath: string | null = null;
  if (currentRaw !== null) {
    const ts = Date.now();
    backupPath = `${configPath}.bak.${ts}`;
    await fsp.copyFile(configPath, backupPath);
  }

  const tempPath = `${configPath}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(tempPath, raw, { encoding: "utf-8", mode: 0o600 });
  await fsyncFile(tempPath);

  try {
    await fsp.rename(tempPath, configPath);
  } catch (error) {
    await fsp.unlink(tempPath).catch(() => {});
    throw error;
  }

  await fsyncDirectory(dir).catch(() => {});

  if (backupPath) {
    await pruneBackups(configPath, backupLimit);
  }

  return { rawHash: hashConfigRaw(raw), backupPath };
}
