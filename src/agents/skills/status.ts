import { parseFrontmatter, type Skill } from "@mariozechner/pi-coding-agent";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import type { MoziConfig } from "../../config";

export type Requirements = {
  bins: string[];
  anyBins: string[];
  env: string[];
  config: string[];
  os: string[];
};

export type RequirementConfigCheck = {
  path: string;
  satisfied: boolean;
};

export type SkillInstallSpec = {
  id?: string;
  kind: "brew" | "node" | "go" | "uv" | "download";
  label?: string;
  bins?: string[];
  os?: string[];
  formula?: string;
  package?: string;
  module?: string;
  url?: string;
  archive?: string;
  extract?: boolean;
  stripComponents?: number;
  targetDir?: string;
};

export type SkillMetadata = {
  always?: boolean;
  emoji?: string;
  homepage?: string;
  os?: string[];
  requires?: {
    bins?: string[];
    anyBins?: string[];
    env?: string[];
    config?: string[];
  };
  install?: SkillInstallSpec[];
};

export type SkillInstallOption = {
  id: string;
  kind: SkillInstallSpec["kind"];
  label: string;
  bins: string[];
};

export type SkillStatusEntry = {
  name: string;
  description: string;
  filePath: string;
  baseDir: string;
  source: string;
  emoji?: string;
  homepage?: string;
  requirements: Requirements;
  missing: Requirements;
  configChecks: RequirementConfigCheck[];
  eligible: boolean;
  install: SkillInstallOption[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeStringList(value: unknown): string[] {
  if (!value) {
    return [];
  }
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter(Boolean);
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? [trimmed] : [];
  }
  return [];
}

function normalizeInstallSpecs(raw: unknown): SkillInstallSpec[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const specs: SkillInstallSpec[] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) {
      continue;
    }
    const kind = entry.kind;
    if (
      kind !== "brew" &&
      kind !== "node" &&
      kind !== "go" &&
      kind !== "uv" &&
      kind !== "download"
    ) {
      continue;
    }
    specs.push({
      id: typeof entry.id === "string" ? entry.id : undefined,
      kind,
      label: typeof entry.label === "string" ? entry.label : undefined,
      bins: normalizeStringList(entry.bins),
      os: normalizeStringList(entry.os),
      formula: typeof entry.formula === "string" ? entry.formula : undefined,
      package: typeof entry.package === "string" ? entry.package : undefined,
      module: typeof entry.module === "string" ? entry.module : undefined,
      url: typeof entry.url === "string" ? entry.url : undefined,
      archive: typeof entry.archive === "string" ? entry.archive : undefined,
      extract: typeof entry.extract === "boolean" ? entry.extract : undefined,
      stripComponents:
        typeof entry.stripComponents === "number" ? entry.stripComponents : undefined,
      targetDir: typeof entry.targetDir === "string" ? entry.targetDir : undefined,
    });
  }
  return specs;
}

function resolveMetadata(frontmatter: Record<string, unknown>): SkillMetadata | undefined {
  let metadataSource: unknown = undefined;
  if (isRecord(frontmatter.metadata)) {
    const meta = frontmatter.metadata as Record<string, unknown>;
    if (isRecord(meta.openclaw)) {
      metadataSource = meta.openclaw;
    } else if (isRecord(meta.mozi)) {
      metadataSource = meta.mozi;
    } else if (typeof meta.openclaw === "string") {
      try {
        metadataSource = JSON.parse(meta.openclaw);
      } catch {
        metadataSource = undefined;
      }
    }
  }
  if (!metadataSource && isRecord(frontmatter.openclaw)) {
    metadataSource = frontmatter.openclaw;
  }
  if (!metadataSource && isRecord(frontmatter.mozi)) {
    metadataSource = frontmatter.mozi;
  }
  if (!isRecord(metadataSource)) {
    return undefined;
  }
  const meta = metadataSource as Record<string, unknown>;
  const requiresRaw = isRecord(meta.requires) ? meta.requires : undefined;
  const requires = requiresRaw
    ? {
        bins: normalizeStringList(requiresRaw.bins),
        anyBins: normalizeStringList(requiresRaw.anyBins),
        env: normalizeStringList(requiresRaw.env),
        config: normalizeStringList(requiresRaw.config),
      }
    : undefined;
  const osList = normalizeStringList(meta.os);
  const install = normalizeInstallSpecs(meta.install);
  return {
    always: meta.always === true,
    emoji: typeof meta.emoji === "string" ? meta.emoji : undefined,
    homepage: typeof meta.homepage === "string" ? meta.homepage : undefined,
    os: osList.length > 0 ? osList : undefined,
    requires,
    install: install.length > 0 ? install : undefined,
  };
}

function resolveConfigPath(config: unknown, pathStr: string): unknown {
  const parts = pathStr.split(".").filter(Boolean);
  let current: unknown = config;
  for (const part of parts) {
    if (typeof current !== "object" || current === null) {
      return undefined;
    }
    const record = current as Record<string, unknown>;
    current = record[part];
  }
  return current;
}

function isTruthy(value: unknown): boolean {
  if (value === undefined || value === null) {
    return false;
  }
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return value !== 0;
  }
  if (typeof value === "string") {
    return value.trim().length > 0;
  }
  return true;
}

function isConfigPathTruthy(config: unknown, pathStr: string): boolean {
  return isTruthy(resolveConfigPath(config, pathStr));
}

function resolveNodeManager(config?: MoziConfig): "npm" | "pnpm" | "yarn" {
  const raw = config?.skills?.install?.nodeManager;
  if (raw === "pnpm" || raw === "yarn" || raw === "npm") {
    return raw;
  }
  return "npm";
}

function formatInstallLabel(spec: SkillInstallSpec, nodeManager: string): string {
  if (spec.label && spec.label.trim()) {
    return spec.label.trim();
  }
  if (spec.kind === "brew" && spec.formula) {
    return `Install ${spec.formula} (brew)`;
  }
  if (spec.kind === "node" && spec.package) {
    return `Install ${spec.package} (${nodeManager})`;
  }
  if (spec.kind === "go" && spec.module) {
    return `Install ${spec.module} (go)`;
  }
  if (spec.kind === "uv" && spec.package) {
    return `Install ${spec.package} (uv)`;
  }
  if (spec.kind === "download" && spec.url) {
    const url = spec.url.trim();
    const last = url.split("/").pop();
    return `Download ${last && last.length > 0 ? last : url}`;
  }
  return "Run installer";
}

function normalizeInstallOptions(
  specs: SkillInstallSpec[] | undefined,
  nodeManager: string,
): SkillInstallOption[] {
  if (!specs || specs.length === 0) {
    return [];
  }
  const options: SkillInstallOption[] = [];
  for (const [index, spec] of specs.entries()) {
    if (spec.os && spec.os.length > 0 && !spec.os.includes(process.platform)) {
      continue;
    }
    options.push({
      id: spec.id?.trim() || `${spec.kind}-${index}`,
      kind: spec.kind,
      label: formatInstallLabel(spec, nodeManager),
      bins: spec.bins ?? [],
    });
  }
  return options;
}

function resolveMissingBins(required: string[]): string[] {
  return required.filter((bin) => !hasBinary(bin));
}

function resolveMissingAnyBins(required: string[]): string[] {
  if (required.length === 0) {
    return [];
  }
  const anyFound = required.some((bin) => hasBinary(bin));
  return anyFound ? [] : required;
}

function resolveMissingEnv(required: string[]): string[] {
  return required.filter((envName) => !process.env[envName]?.trim());
}

function resolveMissingOs(required: string[]): string[] {
  if (required.length === 0) {
    return [];
  }
  return required.includes(process.platform) ? [] : required;
}

let cachedHasBinaryPath: string | undefined;
let cachedHasBinaryPathExt: string | undefined;
const hasBinaryCache = new Map<string, boolean>();

function windowsPathExtensions(): string[] {
  const raw = process.env.PATHEXT;
  const list =
    raw !== undefined ? raw.split(";").map((value) => value.trim()) : [".EXE", ".CMD", ".BAT"];
  return ["", ...list.filter(Boolean)];
}

function hasBinary(bin: string): boolean {
  const pathEnv = process.env.PATH ?? "";
  const pathExt = process.platform === "win32" ? (process.env.PATHEXT ?? "") : "";
  if (cachedHasBinaryPath !== pathEnv || cachedHasBinaryPathExt !== pathExt) {
    cachedHasBinaryPath = pathEnv;
    cachedHasBinaryPathExt = pathExt;
    hasBinaryCache.clear();
  }
  if (hasBinaryCache.has(bin)) {
    return hasBinaryCache.get(bin)!;
  }

  const parts = pathEnv.split(path.delimiter).filter(Boolean);
  const extensions = process.platform === "win32" ? windowsPathExtensions() : [""];
  for (const part of parts) {
    for (const ext of extensions) {
      const candidate = path.join(part, bin + ext);
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        hasBinaryCache.set(bin, true);
        return true;
      } catch {
        // keep scanning
      }
    }
  }
  hasBinaryCache.set(bin, false);
  return false;
}

async function readSkillMetadata(skill: Skill): Promise<SkillMetadata | undefined> {
  try {
    const raw = await fsp.readFile(skill.filePath, "utf-8");
    const { frontmatter } = parseFrontmatter(raw);
    if (!frontmatter || !isRecord(frontmatter)) {
      return undefined;
    }
    return resolveMetadata(frontmatter);
  } catch {
    return undefined;
  }
}

export async function buildSkillStatusEntries(params: {
  skills: Skill[];
  config?: MoziConfig;
}): Promise<SkillStatusEntry[]> {
  const nodeManager = resolveNodeManager(params.config);
  const entries = await Promise.all(
    params.skills.map(async (skill) => {
      const metadata = await readSkillMetadata(skill);
      const required: Requirements = {
        bins: normalizeStringList(metadata?.requires?.bins),
        anyBins: normalizeStringList(metadata?.requires?.anyBins),
        env: normalizeStringList(metadata?.requires?.env),
        config: normalizeStringList(metadata?.requires?.config),
        os: normalizeStringList(metadata?.os),
      };

      const configChecks = required.config.map((configPath) => ({
        path: configPath,
        satisfied: isConfigPathTruthy(params.config, configPath),
      }));

      const missing: Requirements = {
        bins: resolveMissingBins(required.bins),
        anyBins: resolveMissingAnyBins(required.anyBins),
        env: resolveMissingEnv(required.env),
        config: configChecks.filter((check) => !check.satisfied).map((check) => check.path),
        os: resolveMissingOs(required.os),
      };

      const eligible = metadata?.always
        ? true
        : missing.bins.length === 0 &&
          missing.anyBins.length === 0 &&
          missing.env.length === 0 &&
          missing.config.length === 0 &&
          missing.os.length === 0;

      const install = normalizeInstallOptions(metadata?.install, nodeManager);

      return {
        name: skill.name,
        description: skill.description,
        filePath: skill.filePath,
        baseDir: skill.baseDir,
        source: skill.source,
        emoji: metadata?.emoji,
        homepage: metadata?.homepage,
        requirements: required,
        missing: metadata?.always
          ? { bins: [], anyBins: [], env: [], config: [], os: [] }
          : missing,
        configChecks,
        eligible,
        install,
      } satisfies SkillStatusEntry;
    }),
  );

  return entries.sort((a, b) => a.name.localeCompare(b.name));
}
