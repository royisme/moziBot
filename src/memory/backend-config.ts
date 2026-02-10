import os from "node:os";
import path from "node:path";
import { z } from "zod";
import type { MoziConfig } from "../config";
import type { MemoryConfig } from "../config/schema/memory";

export type ResolvedMemoryPersistenceConfig = {
  enabled: boolean;
  onOverflowCompaction: boolean;
  onNewReset: boolean;
  maxMessages: number;
  maxChars: number;
  timeoutMs: number;
};

export type ResolvedMemoryBackendConfig = {
  backend: "builtin" | "qmd";
  citations: "auto" | "always" | "never";
  builtin: ResolvedBuiltinMemoryConfig;
  qmd?: ResolvedQmdConfig;
  persistence: ResolvedMemoryPersistenceConfig;
};

export type ResolvedBuiltinMemoryConfig = {
  sync: {
    onSessionStart: boolean;
    onSearch: boolean;
    watch: boolean;
    watchDebounceMs: number;
    intervalMinutes: number;
    forceOnFlush: boolean;
  };
};

const DEFAULT_PERSISTENCE: ResolvedMemoryPersistenceConfig = {
  enabled: false,
  onOverflowCompaction: true,
  onNewReset: true,
  maxMessages: 12,
  maxChars: 4000,
  timeoutMs: 1500,
};

const DEFAULT_BUILTIN_SYNC = {
  onSessionStart: true,
  onSearch: true,
  watch: true,
  watchDebounceMs: 1_500,
  intervalMinutes: 0,
  forceOnFlush: true,
} as const;

export type ResolvedQmdCollection = {
  name: string;
  path: string;
  pattern: string;
  kind: "memory" | "custom" | "sessions";
};

export type ResolvedQmdUpdateConfig = {
  intervalMs: number;
  debounceMs: number;
  onBoot: boolean;
  embedIntervalMs: number;
};

export type ResolvedQmdLimitsConfig = {
  maxResults: number;
  maxSnippetChars: number;
  maxInjectedChars: number;
  timeoutMs: number;
};

export type ResolvedQmdSessionConfig = {
  enabled: boolean;
  exportDir?: string;
  retentionDays?: number;
};

export type ResolvedQmdReliabilityConfig = {
  maxRetries: number;
  retryBackoffMs: number;
  circuitBreakerThreshold: number;
  circuitOpenMs: number;
};

type MemoryQmdConfig = NonNullable<MemoryConfig["qmd"]>;

export type ResolvedQmdConfig = {
  command: string;
  collections: ResolvedQmdCollection[];
  sessions: ResolvedQmdSessionConfig;
  reliability: ResolvedQmdReliabilityConfig;
  update: ResolvedQmdUpdateConfig;
  limits: ResolvedQmdLimitsConfig;
  includeDefaultMemory: boolean;
  scope?: MemoryQmdConfig["scope"];
};

const DEFAULT_BACKEND = "builtin" as const;
const DEFAULT_CITATIONS = "auto" as const;
const DEFAULT_QMD_INTERVAL = "5m";
const DEFAULT_QMD_DEBOUNCE_MS = 15_000;
const DEFAULT_QMD_TIMEOUT_MS = 4_000;
const DEFAULT_QMD_EMBED_INTERVAL = "60m";
const DEFAULT_QMD_LIMITS: ResolvedQmdLimitsConfig = {
  maxResults: 6,
  maxSnippetChars: 700,
  maxInjectedChars: 4_000,
  timeoutMs: DEFAULT_QMD_TIMEOUT_MS,
};
const DEFAULT_QMD_SCOPE: NonNullable<MemoryQmdConfig["scope"]> = {
  default: "deny",
  rules: [
    {
      action: "allow",
      match: { chatType: "direct" },
    },
  ],
};

const ResolvedQmdConfigSchema = z
  .object({
    command: z.string(),
    collections: z.array(
      z.object({
        name: z.string(),
        path: z.string(),
        pattern: z.string(),
        kind: z.enum(["memory", "custom", "sessions"]),
      }),
    ),
    sessions: z.object({
      enabled: z.boolean(),
      exportDir: z.string().optional(),
      retentionDays: z.number().optional(),
    }),
    reliability: z.object({
      maxRetries: z.number(),
      retryBackoffMs: z.number(),
      circuitBreakerThreshold: z.number(),
      circuitOpenMs: z.number(),
    }),
    update: z.object({
      intervalMs: z.number(),
      debounceMs: z.number(),
      onBoot: z.boolean(),
      embedIntervalMs: z.number(),
    }),
    limits: z.object({
      maxResults: z.number(),
      maxSnippetChars: z.number(),
      maxInjectedChars: z.number(),
      timeoutMs: z.number(),
    }),
    includeDefaultMemory: z.boolean(),
    scope: z.any().optional(),
  })
  .strict();

function sanitizeName(input: string): string {
  const lower = input.toLowerCase().replace(/[^a-z0-9-]+/g, "-");
  const trimmed = lower.replace(/^-+|-+$/g, "");
  return trimmed || "collection";
}

function ensureUniqueName(base: string, existing: Set<string>): string {
  const name = sanitizeName(base);
  if (!existing.has(name)) {
    existing.add(name);
    return name;
  }
  let suffix = 2;
  while (existing.has(`${name}-${suffix}`)) {
    suffix += 1;
  }
  const unique = `${name}-${suffix}`;
  existing.add(unique);
  return unique;
}

function resolveUserPath(input: string): string {
  if (input.startsWith("~/") || input === "~") {
    return path.join(os.homedir(), input.slice(2));
  }
  return input;
}

function resolvePath(raw: string, workspaceDir: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error("path required");
  }
  if (trimmed.startsWith("~") || path.isAbsolute(trimmed)) {
    return path.normalize(resolveUserPath(trimmed));
  }
  return path.normalize(path.resolve(workspaceDir, trimmed));
}

function parseDurationMs(raw: string, fallbackMs: number): number {
  const trimmed = raw.trim();
  if (!trimmed) {
    return fallbackMs;
  }
  const match = /^([0-9]+(?:\.[0-9]+)?)(ms|s|m|h|d)?$/i.exec(trimmed);
  if (!match) {
    return fallbackMs;
  }
  const value = Number(match[1]);
  if (!Number.isFinite(value)) {
    return fallbackMs;
  }
  const unit = (match[2] || "ms").toLowerCase();
  const multipliers: Record<string, number> = {
    ms: 1,
    s: 1000,
    m: 60 * 1000,
    h: 60 * 60 * 1000,
    d: 24 * 60 * 60 * 1000,
  };
  const multiplier = multipliers[unit] ?? 1;
  return Math.max(0, Math.floor(value * multiplier));
}

function resolveIntervalMs(raw?: string): number {
  if (!raw?.trim()) {
    return parseDurationMs(DEFAULT_QMD_INTERVAL, 300_000);
  }
  return parseDurationMs(raw, parseDurationMs(DEFAULT_QMD_INTERVAL, 300_000));
}

function resolveEmbedIntervalMs(raw?: string): number {
  if (!raw?.trim()) {
    return parseDurationMs(DEFAULT_QMD_EMBED_INTERVAL, 3_600_000);
  }
  return parseDurationMs(raw, parseDurationMs(DEFAULT_QMD_EMBED_INTERVAL, 3_600_000));
}

function resolveDebounceMs(raw?: number): number {
  if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0) {
    return Math.floor(raw);
  }
  return DEFAULT_QMD_DEBOUNCE_MS;
}

function resolveLimits(raw?: MemoryQmdConfig["limits"]): ResolvedQmdLimitsConfig {
  const parsed: ResolvedQmdLimitsConfig = { ...DEFAULT_QMD_LIMITS };
  if (raw?.maxResults && raw.maxResults > 0) {
    parsed.maxResults = Math.floor(raw.maxResults);
  }
  if (raw?.maxSnippetChars && raw.maxSnippetChars > 0) {
    parsed.maxSnippetChars = Math.floor(raw.maxSnippetChars);
  }
  if (raw?.maxInjectedChars && raw.maxInjectedChars > 0) {
    parsed.maxInjectedChars = Math.floor(raw.maxInjectedChars);
  }
  if (raw?.timeoutMs && raw.timeoutMs > 0) {
    parsed.timeoutMs = Math.floor(raw.timeoutMs);
  }
  return parsed;
}

function resolveSessionConfig(
  cfg: MemoryQmdConfig["sessions"],
  homeDir: string,
): ResolvedQmdSessionConfig {
  const enabled = Boolean(cfg?.enabled);
  const exportDirRaw = cfg?.exportDir?.trim();
  const exportDir = exportDirRaw ? resolvePath(exportDirRaw, homeDir) : undefined;
  const retentionDays =
    cfg?.retentionDays && cfg.retentionDays > 0 ? Math.floor(cfg.retentionDays) : undefined;
  return {
    enabled,
    exportDir,
    retentionDays,
  };
}

function resolveReliabilityConfig(
  cfg: MemoryQmdConfig["reliability"],
): ResolvedQmdReliabilityConfig {
  return {
    maxRetries: Math.max(0, Math.floor(cfg?.maxRetries ?? 2)),
    retryBackoffMs: Math.max(0, Math.floor(cfg?.retryBackoffMs ?? 500)),
    circuitBreakerThreshold: Math.max(1, Math.floor(cfg?.circuitBreakerThreshold ?? 3)),
    circuitOpenMs: Math.max(1000, Math.floor(cfg?.circuitOpenMs ?? 30000)),
  };
}

function resolveCustomPaths(
  rawPaths: MemoryQmdConfig["paths"],
  homeDir: string,
  existing: Set<string>,
): ResolvedQmdCollection[] {
  if (!rawPaths?.length) {
    return [];
  }
  const collections: ResolvedQmdCollection[] = [];
  rawPaths.forEach((entry, index) => {
    const trimmedPath = entry?.path?.trim();
    if (!trimmedPath) {
      return;
    }
    let resolved: string;
    try {
      resolved = resolvePath(trimmedPath, homeDir);
    } catch {
      return;
    }
    const pattern = entry.pattern?.trim() || "**/*.md";
    const baseName = entry.name?.trim() || `custom-${index + 1}`;
    const name = ensureUniqueName(baseName, existing);
    collections.push({
      name,
      path: resolved,
      pattern,
      kind: "custom",
    });
  });
  return collections;
}

function resolveDefaultCollections(
  include: boolean,
  homeDir: string,
  existing: Set<string>,
): ResolvedQmdCollection[] {
  if (!include) {
    return [];
  }
  const entries: Array<{ path: string; pattern: string; base: string }> = [
    { path: homeDir, pattern: "MEMORY.md", base: "memory-root" },
    {
      path: path.join(homeDir, "memory"),
      pattern: "**/*.md",
      base: "memory-dir",
    },
  ];
  return entries.map((entry) => ({
    name: ensureUniqueName(entry.base, existing),
    path: entry.path,
    pattern: entry.pattern,
    kind: "memory",
  }));
}

function resolveCommandBinary(raw: string | undefined): string {
  const trimmed = raw?.trim() || "qmd";
  const parts = trimmed.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g);
  if (!parts?.length) {
    return trimmed.split(/\s+/)[0] || "qmd";
  }
  const first = parts[0] ?? "qmd";
  return first.replace(/^"|"$/g, "").replace(/^'|'$/g, "") || "qmd";
}

export function resolveWorkspaceDir(cfg: MoziConfig, agentId: string): string {
  const agents = cfg.agents as Record<string, { workspace?: string }> | undefined;
  const entry = agents?.[agentId];
  if (entry?.workspace) {
    return entry.workspace;
  }
  const baseDir = cfg.paths?.baseDir;
  if (baseDir) {
    return path.join(baseDir, "agents", agentId, "workspace");
  }
  const base = (cfg.paths as unknown as { workspace?: string })?.workspace || "./workspace";
  return path.join(base, agentId);
}

export function resolveHomeDir(cfg: MoziConfig, agentId: string): string {
  const agents = cfg.agents as Record<string, { home?: string }> | undefined;
  const entry = agents?.[agentId];
  if (entry?.home) {
    return entry.home;
  }
  const baseDir = cfg.paths?.baseDir;
  if (baseDir) {
    return path.join(baseDir, "agents", agentId, "home");
  }
  return path.join(".", "agents", agentId, "home");
}

export function resolveMemoryBackendConfig(params: {
  cfg: MoziConfig;
  agentId: string;
}): ResolvedMemoryBackendConfig {
  const backend = params.cfg.memory?.backend ?? DEFAULT_BACKEND;
  const citations = params.cfg.memory?.citations ?? DEFAULT_CITATIONS;

  const persistence: ResolvedMemoryPersistenceConfig = {
    enabled: params.cfg.memory?.persistence?.enabled ?? DEFAULT_PERSISTENCE.enabled,
    onOverflowCompaction:
      params.cfg.memory?.persistence?.onOverflowCompaction ??
      DEFAULT_PERSISTENCE.onOverflowCompaction,
    onNewReset: params.cfg.memory?.persistence?.onNewReset ?? DEFAULT_PERSISTENCE.onNewReset,
    maxMessages: params.cfg.memory?.persistence?.maxMessages ?? DEFAULT_PERSISTENCE.maxMessages,
    maxChars: params.cfg.memory?.persistence?.maxChars ?? DEFAULT_PERSISTENCE.maxChars,
    timeoutMs: params.cfg.memory?.persistence?.timeoutMs ?? DEFAULT_PERSISTENCE.timeoutMs,
  };

  const builtin: ResolvedBuiltinMemoryConfig = {
    sync: {
      onSessionStart:
        params.cfg.memory?.builtin?.sync?.onSessionStart ?? DEFAULT_BUILTIN_SYNC.onSessionStart,
      onSearch: params.cfg.memory?.builtin?.sync?.onSearch ?? DEFAULT_BUILTIN_SYNC.onSearch,
      watch: params.cfg.memory?.builtin?.sync?.watch ?? DEFAULT_BUILTIN_SYNC.watch,
      watchDebounceMs: Math.max(
        0,
        Math.floor(
          params.cfg.memory?.builtin?.sync?.watchDebounceMs ?? DEFAULT_BUILTIN_SYNC.watchDebounceMs,
        ),
      ),
      intervalMinutes: Math.max(
        0,
        Math.floor(
          params.cfg.memory?.builtin?.sync?.intervalMinutes ?? DEFAULT_BUILTIN_SYNC.intervalMinutes,
        ),
      ),
      forceOnFlush:
        params.cfg.memory?.builtin?.sync?.forceOnFlush ?? DEFAULT_BUILTIN_SYNC.forceOnFlush,
    },
  };

  if (backend !== "qmd") {
    return { backend: "builtin", citations, builtin, persistence };
  }

  const homeDir = resolveHomeDir(params.cfg, params.agentId);
  const workspaceDir = resolveWorkspaceDir(params.cfg, params.agentId);
  const qmdCfg = params.cfg.memory?.qmd;
  const includeDefaultMemory = qmdCfg?.includeDefaultMemory !== false;
  const nameSet = new Set<string>();
  const collections = [
    ...resolveDefaultCollections(includeDefaultMemory, homeDir, nameSet),
    ...resolveCustomPaths(qmdCfg?.paths, homeDir, nameSet),
  ];

  // workspaceDir is retained for future workspace indexing policies
  void workspaceDir;

  const command = resolveCommandBinary(qmdCfg?.command);
  const resolved: ResolvedQmdConfig = {
    command,
    collections,
    includeDefaultMemory,
    sessions: resolveSessionConfig(qmdCfg?.sessions, homeDir),
    reliability: resolveReliabilityConfig(qmdCfg?.reliability),
    update: {
      intervalMs: resolveIntervalMs(qmdCfg?.update?.interval),
      debounceMs: resolveDebounceMs(qmdCfg?.update?.debounceMs),
      onBoot: qmdCfg?.update?.onBoot !== false,
      embedIntervalMs: resolveEmbedIntervalMs(qmdCfg?.update?.embedInterval),
    },
    limits: resolveLimits(qmdCfg?.limits),
    scope: qmdCfg?.scope ?? (DEFAULT_QMD_SCOPE as unknown as ResolvedQmdConfig["scope"]),
  };

  ResolvedQmdConfigSchema.parse(resolved);

  return {
    backend: "qmd",
    citations,
    builtin,
    qmd: resolved,
    persistence,
  };
}
