import { config as loadDotEnv } from "dotenv";
import { parse as parseJsonc } from "jsonc-parser";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { replaceEnvVars } from "./env";
import { processIncludes } from "./includes";
import { MoziConfigSchema, type MoziConfig } from "./schema";

export interface ConfigLoadResult {
  success: boolean;
  config?: MoziConfig;
  errors?: string[];
  path: string;
}

export function resolveConfigPath(customPath?: string): string {
  const envPath = process.env.MOZI_CONFIG;
  if (customPath) {
    return path.resolve(customPath);
  }
  if (envPath) {
    return path.resolve(envPath);
  }
  const home = os.homedir();
  return path.join(home, ".mozi", "config.jsonc");
}

export function applyConfigDefaults(raw: unknown): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return raw;
  }
  const home = os.homedir();
  const baseDir = path.join(home, ".mozi");
  const obj = { ...(raw as Record<string, unknown>) };
  const paths =
    obj.paths && typeof obj.paths === "object" && !Array.isArray(obj.paths)
      ? { ...(obj.paths as Record<string, unknown>) }
      : {};
  if (!paths.baseDir) {
    paths.baseDir = baseDir;
  }
  if (!paths.sessions) {
    paths.sessions = path.join(baseDir, "sessions");
  }
  if (!paths.logs) {
    paths.logs = path.join(baseDir, "logs");
  }
  obj.paths = paths;

  if (!Object.hasOwn(obj, "logging")) {
    obj.logging = { level: "info" };
    return obj;
  }

  if (obj.logging && typeof obj.logging === "object" && !Array.isArray(obj.logging)) {
    const logging = { ...(obj.logging as Record<string, unknown>) };
    if (!Object.hasOwn(logging, "level")) {
      logging.level = "info";
    }
    obj.logging = logging;
  }

  return obj;
}

function loadConfigLocalEnv(resolvedPath: string): void {
  const configDir = path.dirname(resolvedPath);
  const envFiles = [".env", ".env.var"];

  for (const envFile of envFiles) {
    const envPath = path.join(configDir, envFile);
    if (!fs.existsSync(envPath)) {
      continue;
    }
    const result = loadDotEnv({ path: envPath, override: false, quiet: true });
    if (result.error) {
      throw result.error;
    }
  }
}

export function loadConfig(configPath?: string): ConfigLoadResult {
  const resolvedPath = resolveConfigPath(configPath);
  if (!fs.existsSync(resolvedPath)) {
    return {
      success: false,
      errors: [`Config file not found: ${resolvedPath}`],
      path: resolvedPath,
    };
  }

  try {
    loadConfigLocalEnv(resolvedPath);
    const raw = fs.readFileSync(resolvedPath, "utf-8");
    let config: unknown = parseJsonc(raw);
    config = processIncludes(config, resolvedPath);
    config = replaceEnvVars(config);
    config = applyConfigDefaults(config);

    const result = MoziConfigSchema.safeParse(config);
    if (!result.success) {
      const errors = result.error.issues.map(
        (issue) => `${issue.path.join(".")}: ${issue.message}`,
      );
      return { success: false, errors, path: resolvedPath };
    }

    return { success: true, config: result.data, path: resolvedPath };
  } catch (error) {
    return {
      success: false,
      errors: [error instanceof Error ? error.message : String(error)],
      path: resolvedPath,
    };
  }
}
