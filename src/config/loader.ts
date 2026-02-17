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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function expandHomePath(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("~")) {
    return raw;
  }
  if (trimmed === "~") {
    return os.homedir();
  }
  if (trimmed.startsWith("~/")) {
    return path.join(os.homedir(), trimmed.slice(2));
  }
  return raw;
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
  if (!isRecord(raw)) {
    return raw;
  }
  const home = os.homedir();
  const obj = { ...raw };
  const paths = isRecord(obj.paths) ? { ...obj.paths } : {};
  const configuredBaseDir =
    typeof paths.baseDir === "string" && paths.baseDir.trim()
      ? expandHomePath(paths.baseDir)
      : undefined;
  const baseDir = configuredBaseDir ?? path.join(home, ".mozi");

  paths.baseDir = baseDir;
  paths.sessions =
    typeof paths.sessions === "string"
      ? expandHomePath(paths.sessions)
      : path.join(baseDir, "sessions");
  paths.logs =
    typeof paths.logs === "string" ? expandHomePath(paths.logs) : path.join(baseDir, "logs");
  if (typeof paths.skills === "string") {
    paths.skills = expandHomePath(paths.skills);
  }
  if (typeof paths.workspace === "string") {
    paths.workspace = expandHomePath(paths.workspace);
  }
  obj.paths = paths;

  if (isRecord(obj.agents)) {
    const agents = { ...obj.agents };
    for (const [agentId, agentValue] of Object.entries(agents)) {
      if (agentId === "defaults" || !isRecord(agentValue)) {
        continue;
      }
      const nextAgent = { ...agentValue };
      if (typeof nextAgent.home === "string") {
        nextAgent.home = expandHomePath(nextAgent.home);
      }
      if (typeof nextAgent.workspace === "string") {
        nextAgent.workspace = expandHomePath(nextAgent.workspace);
      }
      agents[agentId] = nextAgent;
    }
    obj.agents = agents;
  }

  if (isRecord(obj.skills)) {
    const skills = { ...obj.skills };
    if (Array.isArray(skills.dirs)) {
      skills.dirs = skills.dirs.map((value) =>
        typeof value === "string" ? expandHomePath(value) : value,
      );
    }
    if (typeof skills.installDir === "string") {
      skills.installDir = expandHomePath(skills.installDir);
    }
    obj.skills = skills;
  }

  if (isRecord(obj.extensions) && isRecord(obj.extensions.load)) {
    const extensions = { ...obj.extensions };
    const load = { ...extensions.load };
    if (Array.isArray(load.paths)) {
      load.paths = load.paths.map((value) =>
        typeof value === "string" ? expandHomePath(value) : value,
      );
    }
    extensions.load = load;
    obj.extensions = extensions;
  }

  if (!Object.hasOwn(obj, "logging")) {
    obj.logging = { level: "info" };
    return obj;
  }

  if (isRecord(obj.logging)) {
    const logging = { ...obj.logging };
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
