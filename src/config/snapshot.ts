import crypto from "node:crypto";
import fs from "node:fs";
import type { MoziConfig } from "./schema";
import { loadConfig, resolveConfigPath, type ConfigLoadResult } from "./loader";

export interface ConfigSnapshot {
  path: string;
  exists: boolean;
  raw: string | null;
  rawHash: string;
  load: ConfigLoadResult;
  effectiveConfig: MoziConfig | null;
  effectiveHash: string | null;
}

export function hashConfigRaw(raw: string | null): string {
  return crypto
    .createHash("sha256")
    .update(raw ?? "")
    .digest("hex");
}

export function readConfigSnapshot(configPath?: string): ConfigSnapshot {
  const path = resolveConfigPath(configPath);
  const exists = fs.existsSync(path);
  const raw = exists ? fs.readFileSync(path, "utf-8") : null;
  const rawHash = hashConfigRaw(raw);
  const load = loadConfig(path);
  const effectiveConfig = load.success ? (load.config ?? null) : null;
  const effectiveHash = effectiveConfig ? hashConfigRaw(JSON.stringify(effectiveConfig)) : null;

  return {
    path,
    exists,
    raw,
    rawHash,
    load,
    effectiveConfig,
    effectiveHash,
  };
}
