import { createJiti } from "jiti";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { MoziConfig } from "../../config";
import type { RuntimeHookHandlerMap, RuntimeHookName } from "./types";
import { logger } from "../../logger";
import { registerRuntimeHook } from "./index";

type RuntimeHookDefinition = {
  hookName: RuntimeHookName;
  handler: RuntimeHookHandlerMap[RuntimeHookName];
  priority?: number;
  id?: string;
};

type HookModule = {
  hooks?: RuntimeHookDefinition[];
  default?: RuntimeHookDefinition[] | { hooks?: RuntimeHookDefinition[] };
};

const SUPPORTED_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts", ".mjs", ".cjs", ".js"]);

function resolveUserPath(input: string): string {
  if (input.startsWith("~/") || input === "~") {
    return path.join(os.homedir(), input.slice(2));
  }
  return input;
}

function resolveHookPath(config: MoziConfig, raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error("Hook path cannot be empty");
  }
  if (trimmed.startsWith("~") || path.isAbsolute(trimmed)) {
    return path.normalize(resolveUserPath(trimmed));
  }
  const baseDir = config.paths?.baseDir ?? process.cwd();
  return path.normalize(path.resolve(baseDir, trimmed));
}

function expandHookCandidates(config: MoziConfig, raw: string): string[] {
  const resolved = resolveHookPath(config, raw);
  try {
    const stat = fs.statSync(resolved);
    if (stat.isDirectory()) {
      return fs
        .readdirSync(resolved, { withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => path.join(resolved, entry.name))
        .filter((entry) => SUPPORTED_EXTENSIONS.has(path.extname(entry)));
    }
    if (stat.isFile()) {
      return [resolved];
    }
  } catch (error) {
    logger.warn({ path: resolved, error }, "Failed to resolve external hook path");
  }
  return [];
}

function resolveHooks(
  rawModule: HookModule | RuntimeHookDefinition[] | undefined,
): RuntimeHookDefinition[] {
  if (!rawModule) {
    return [];
  }
  if (Array.isArray(rawModule)) {
    return rawModule;
  }
  if (Array.isArray(rawModule.hooks)) {
    return rawModule.hooks;
  }
  if (rawModule.default && Array.isArray(rawModule.default)) {
    return rawModule.default;
  }
  if (rawModule.default && Array.isArray(rawModule.default.hooks)) {
    return rawModule.default.hooks;
  }
  return [];
}

export function loadExternalHooks(config: MoziConfig): string[] {
  const hookConfig = config.runtime?.hooks;
  if (!hookConfig || hookConfig.enabled === false) {
    return [];
  }
  const paths = hookConfig.paths ?? [];
  if (paths.length === 0) {
    return [];
  }

  const jiti = createJiti(import.meta.url, {
    interopDefault: true,
    extensions: [".ts", ".tsx", ".mts", ".cts", ".mjs", ".cjs", ".js", ".json"],
  });

  const registeredIds: string[] = [];
  for (const rawPath of paths) {
    const candidates = expandHookCandidates(config, rawPath);
    for (const candidate of candidates) {
      try {
        const rawModule = jiti(candidate) as HookModule | RuntimeHookDefinition[];
        const hooks = resolveHooks(rawModule);
        if (hooks.length === 0) {
          logger.warn({ path: candidate }, "External hook module exported no hooks");
          continue;
        }
        for (const hook of hooks) {
          if (!hook?.hookName || typeof hook.handler !== "function") {
            logger.warn({ path: candidate }, "Skipping invalid hook definition");
            continue;
          }
          const id = registerRuntimeHook(hook.hookName, hook.handler, {
            id: hook.id,
            priority: hook.priority,
          });
          registeredIds.push(id);
        }
      } catch (error) {
        logger.warn({ path: candidate, error }, "Failed to load external hook module");
      }
    }
  }

  return registeredIds;
}
