import { parse as parseJsonc } from "jsonc-parser";
import { ConfigConflictError, writeConfigRawAtomic } from "./persistence";
import { MoziConfigSchema } from "./schema";
import { readConfigSnapshot, type ConfigSnapshot } from "./snapshot";

type PathSegment = string;

export type ConfigOperation =
  | { op: "set"; path: string; value: unknown }
  | { op: "delete"; path: string }
  | { op: "patch"; value: Record<string, unknown> };

export interface MutateConfigOptions {
  configPath?: string;
  expectedRawHash?: string;
}

export interface MutationResult {
  before: ConfigSnapshot;
  after: ConfigSnapshot;
}

export const CONFIG_REDACTION_SENTINEL = "__MOZI_REDACTED__";

function isIndexSegment(raw: string): boolean {
  return /^[0-9]+$/.test(raw);
}

function parsePath(raw: string): PathSegment[] {
  const trimmed = raw.trim();
  if (!trimmed) {
    return [];
  }
  const parts: string[] = [];
  let current = "";
  let i = 0;
  while (i < trimmed.length) {
    const ch = trimmed[i];
    if (ch === "\\") {
      const next = trimmed[i + 1];
      if (next) {
        current += next;
      }
      i += 2;
      continue;
    }
    if (ch === ".") {
      if (current) {
        parts.push(current);
      }
      current = "";
      i += 1;
      continue;
    }
    if (ch === "[") {
      if (current) {
        parts.push(current);
      }
      current = "";
      const close = trimmed.indexOf("]", i);
      if (close === -1) {
        throw new Error(`Invalid path (missing "]"): ${raw}`);
      }
      const inside = trimmed.slice(i + 1, close).trim();
      if (!inside) {
        throw new Error(`Invalid path (empty "[]"): ${raw}`);
      }
      parts.push(inside);
      i = close + 1;
      continue;
    }
    current += ch;
    i += 1;
  }
  if (current) {
    parts.push(current);
  }
  return parts.map((part) => part.trim()).filter(Boolean);
}

function formatPath(segments: string[]): string {
  return segments.join(".");
}

function sensitiveKeyName(segment: string): boolean {
  const lower = segment.toLowerCase();
  return lower === "apikey" || lower === "bottoken" || lower === "authtoken";
}

function isSensitivePath(segments: string[]): boolean {
  const last = segments[segments.length - 1];
  if (!last) {
    return false;
  }
  return sensitiveKeyName(last);
}

function deepMerge(target: unknown, source: unknown): unknown {
  if (Array.isArray(target) && Array.isArray(source)) {
    return [...target, ...source];
  }
  if (
    typeof target === "object" &&
    target !== null &&
    !Array.isArray(target) &&
    typeof source === "object" &&
    source !== null &&
    !Array.isArray(source)
  ) {
    const result: Record<string, unknown> = { ...(target as Record<string, unknown>) };
    for (const key of Object.keys(source as Record<string, unknown>)) {
      const sourceRecord = source as Record<string, unknown>;
      result[key] = key in result ? deepMerge(result[key], sourceRecord[key]) : sourceRecord[key];
    }
    return result;
  }
  return source;
}

function getAtPath(
  root: Record<string, unknown>,
  path: PathSegment[],
): { found: boolean; value?: unknown } {
  let current: unknown = root;
  for (const segment of path) {
    if (!current || typeof current !== "object") {
      return { found: false };
    }
    if (Array.isArray(current)) {
      if (!isIndexSegment(segment)) {
        return { found: false };
      }
      const index = Number.parseInt(segment, 10);
      if (!Number.isFinite(index) || index < 0 || index >= current.length) {
        return { found: false };
      }
      current = current[index];
      continue;
    }
    const record = current as Record<string, unknown>;
    if (!(segment in record)) {
      return { found: false };
    }
    current = record[segment];
  }
  return { found: true, value: current };
}

function setAtPath(root: Record<string, unknown>, path: PathSegment[], value: unknown): void {
  if (path.length === 0) {
    throw new Error("Config path cannot be empty");
  }
  let current: unknown = root;
  for (let i = 0; i < path.length - 1; i += 1) {
    const segment = path[i];
    const next = path[i + 1];
    const nextIsIndex = Boolean(next && isIndexSegment(next));
    if (Array.isArray(current)) {
      if (!isIndexSegment(segment)) {
        throw new Error(`Expected numeric index for array segment "${segment}"`);
      }
      const index = Number.parseInt(segment, 10);
      const existing = current[index];
      if (!existing || typeof existing !== "object") {
        current[index] = nextIsIndex ? [] : {};
      }
      current = current[index];
      continue;
    }
    if (!current || typeof current !== "object") {
      throw new Error(`Cannot traverse into "${segment}" (not an object)`);
    }
    const record = current as Record<string, unknown>;
    const existing = record[segment];
    if (!existing || typeof existing !== "object") {
      record[segment] = nextIsIndex ? [] : {};
    }
    current = record[segment];
  }

  const last = path[path.length - 1];
  if (Array.isArray(current)) {
    if (!isIndexSegment(last)) {
      throw new Error(`Expected numeric index for array segment "${last}"`);
    }
    const index = Number.parseInt(last, 10);
    current[index] = value;
    return;
  }
  if (!current || typeof current !== "object") {
    throw new Error(`Cannot set "${last}" (parent is not an object)`);
  }
  (current as Record<string, unknown>)[last] = value;
}

function unsetAtPath(root: Record<string, unknown>, path: PathSegment[]): boolean {
  if (path.length === 0) {
    return false;
  }
  let current: unknown = root;
  for (let i = 0; i < path.length - 1; i += 1) {
    const segment = path[i];
    if (!current || typeof current !== "object") {
      return false;
    }
    if (Array.isArray(current)) {
      if (!isIndexSegment(segment)) {
        return false;
      }
      const index = Number.parseInt(segment, 10);
      if (!Number.isFinite(index) || index < 0 || index >= current.length) {
        return false;
      }
      current = current[index];
      continue;
    }
    const record = current as Record<string, unknown>;
    if (!(segment in record)) {
      return false;
    }
    current = record[segment];
  }

  const last = path[path.length - 1];
  if (Array.isArray(current)) {
    if (!isIndexSegment(last)) {
      return false;
    }
    const index = Number.parseInt(last, 10);
    if (!Number.isFinite(index) || index < 0 || index >= current.length) {
      return false;
    }
    current.splice(index, 1);
    return true;
  }
  if (!current || typeof current !== "object") {
    return false;
  }
  const record = current as Record<string, unknown>;
  if (!(last in record)) {
    return false;
  }
  delete record[last];
  return true;
}

function validateAndSerialize(config: unknown): string {
  const result = MoziConfigSchema.safeParse(config);
  if (!result.success) {
    const detail = result.error.issues
      .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
      .join("; ");
    throw new Error(`Config validation failed: ${detail}`);
  }
  return `${JSON.stringify(result.data, null, 2)}\n`;
}

function baseFromSnapshot(snapshot: ConfigSnapshot): Record<string, unknown> {
  if (snapshot.raw) {
    const parsed = parseJsonc(snapshot.raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  }
  return {};
}

function assertExpectedHash(snapshot: ConfigSnapshot, options: MutateConfigOptions): void {
  if (options.expectedRawHash && options.expectedRawHash !== snapshot.rawHash) {
    throw new ConfigConflictError(
      `Config changed since last read (expected ${options.expectedRawHash}, found ${snapshot.rawHash})`,
    );
  }
}

function resolveRedactionPatch(
  patch: Record<string, unknown>,
  base: Record<string, unknown>,
  rootBase: Record<string, unknown> = base,
  trail: string[] = [],
): Record<string, unknown> {
  const resolved: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) {
    const nextTrail = [...trail, key];
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const baseChild = getAtPath(base, nextTrail);
      const nextBase =
        baseChild.found &&
        baseChild.value &&
        typeof baseChild.value === "object" &&
        !Array.isArray(baseChild.value)
          ? (baseChild.value as Record<string, unknown>)
          : {};
      resolved[key] = resolveRedactionPatch(
        value as Record<string, unknown>,
        nextBase,
        rootBase,
        nextTrail,
      );
      continue;
    }
    if (value === CONFIG_REDACTION_SENTINEL && isSensitivePath(nextTrail)) {
      const existing = getAtPath(rootBase, nextTrail);
      if (!existing.found) {
        throw new Error(
          `Cannot apply redaction sentinel to missing sensitive field: ${formatPath(nextTrail)}`,
        );
      }
      resolved[key] = existing.value;
      continue;
    }
    resolved[key] = value;
  }
  return resolved;
}

function resolveRedactionSetValue(
  base: Record<string, unknown>,
  path: PathSegment[],
  value: unknown,
): unknown {
  if (value === CONFIG_REDACTION_SENTINEL && isSensitivePath(path)) {
    const existing = getAtPath(base, path);
    if (!existing.found) {
      throw new Error(
        `Cannot apply redaction sentinel to missing sensitive field: ${formatPath(path)}`,
      );
    }
    return existing.value;
  }
  return value;
}

async function commitMutatedConfig(
  nextRaw: string,
  before: ConfigSnapshot,
  options: MutateConfigOptions,
): Promise<MutationResult> {
  assertExpectedHash(before, options);
  await writeConfigRawAtomic(before.path, nextRaw, {
    expectedRawHash: options.expectedRawHash,
  });
  const after = readConfigSnapshot(before.path);
  return { before, after };
}

export async function setConfigValue(params: {
  path: string;
  value: unknown;
  options?: MutateConfigOptions;
}): Promise<MutationResult> {
  const options = params.options ?? {};
  const before = readConfigSnapshot(options.configPath);
  const base = baseFromSnapshot(before);
  const path = parsePath(params.path);
  const value = resolveRedactionSetValue(base, path, params.value);
  setAtPath(base, path, value);
  const nextRaw = validateAndSerialize(base);
  return commitMutatedConfig(nextRaw, before, options);
}

export async function deleteConfigValue(params: {
  path: string;
  options?: MutateConfigOptions;
}): Promise<MutationResult> {
  const options = params.options ?? {};
  const before = readConfigSnapshot(options.configPath);
  const base = baseFromSnapshot(before);
  unsetAtPath(base, parsePath(params.path));
  const nextRaw = validateAndSerialize(base);
  return commitMutatedConfig(nextRaw, before, options);
}

export async function patchConfig(params: {
  patch: Record<string, unknown>;
  options?: MutateConfigOptions;
}): Promise<MutationResult> {
  const options = params.options ?? {};
  const before = readConfigSnapshot(options.configPath);
  const base = baseFromSnapshot(before);
  const resolvedPatch = resolveRedactionPatch(params.patch, base);
  const merged = deepMerge(base, resolvedPatch);
  const nextRaw = validateAndSerialize(merged);
  return commitMutatedConfig(nextRaw, before, options);
}

export async function applyConfigOps(params: {
  operations: ConfigOperation[];
  options?: MutateConfigOptions;
}): Promise<MutationResult> {
  const options = params.options ?? {};
  const before = readConfigSnapshot(options.configPath);
  let base: Record<string, unknown> = baseFromSnapshot(before);

  for (const operation of params.operations) {
    if (operation.op === "set") {
      const path = parsePath(operation.path);
      const value = resolveRedactionSetValue(base, path, operation.value);
      setAtPath(base, path, value);
      continue;
    }
    if (operation.op === "delete") {
      unsetAtPath(base, parsePath(operation.path));
      continue;
    }
    if (operation.op === "patch") {
      const resolvedPatch = resolveRedactionPatch(operation.value, base);
      const merged = deepMerge(base, resolvedPatch);
      if (!merged || typeof merged !== "object" || Array.isArray(merged)) {
        throw new Error("Patch operation produced invalid root config");
      }
      base = merged as Record<string, unknown>;
      continue;
    }
  }

  const nextRaw = validateAndSerialize(base);
  return commitMutatedConfig(nextRaw, before, options);
}

export function isConfigConflictError(error: unknown): error is ConfigConflictError {
  return error instanceof ConfigConflictError;
}
