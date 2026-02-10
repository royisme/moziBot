import { parse as parseJsonc } from "jsonc-parser";
import fs from "node:fs";
import path from "node:path";

export const INCLUDE_KEY = "$include";
const MAX_INCLUDE_DEPTH = 10;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepMerge(target: unknown, source: unknown): unknown {
  if (Array.isArray(target) && Array.isArray(source)) {
    return [...target, ...source];
  }
  if (isPlainObject(target) && isPlainObject(source)) {
    const result: Record<string, unknown> = { ...target };
    for (const key of Object.keys(source)) {
      result[key] = key in result ? deepMerge(result[key], source[key]) : source[key];
    }
    return result;
  }
  return source;
}

export function processIncludes(config: unknown, basePath: string, depth = 0): unknown {
  if (depth > MAX_INCLUDE_DEPTH) {
    throw new Error(`Max include depth exceeded: ${basePath}`);
  }

  if (!isPlainObject(config)) {
    return config;
  }

  const obj = config;

  if (INCLUDE_KEY in obj) {
    const includeValue = obj[INCLUDE_KEY];
    const includes = Array.isArray(includeValue) ? includeValue : [includeValue];

    let merged: Record<string, unknown> = {};
    for (const includePath of includes) {
      const fullPath = path.resolve(path.dirname(basePath), String(includePath));
      const raw = fs.readFileSync(fullPath, "utf-8");
      const parsed = parseJsonc(raw);
      const processed = processIncludes(parsed, fullPath, depth + 1);
      merged = deepMerge(merged, processed) as Record<string, unknown>;
    }

    const rest: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      if (key !== INCLUDE_KEY) {
        rest[key] = processIncludes(value, basePath, depth);
      }
    }
    return deepMerge(merged, rest);
  }

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    result[key] = processIncludes(value, basePath, depth);
  }
  return result;
}
