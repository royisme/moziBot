import fs from "node:fs/promises";
import path from "node:path";
import type { ResolvedQmdConfig } from "./backend-config";
import type { MemorySearchResult } from "./types";

type RecallMetricsSnapshot = {
  query: string;
  totalResults: number;
  applied: {
    temporalDecay: boolean;
    mmr: boolean;
  };
  scores: {
    base: number[];
    afterTemporalDecay: number[];
    afterMmr: number[];
  };
  temporalDecay?: {
    halfLifeDays: number;
    evergreenPaths: number;
    datedPaths: number;
    mtimeFallbacks: number;
  };
  mmr?: {
    lambda: number;
  };
};

type DatedPathInfo = {
  date: Date;
  evergreen: boolean;
  source: "filename" | "mtime" | "none";
};

const DAILY_FILE_RE = /(?:^|\/)memory\/(\d{4}-\d{2}-\d{2})\.md$/i;
const MONTHS = new Map<string, number>([
  ["jan", 0],
  ["feb", 1],
  ["mar", 2],
  ["apr", 3],
  ["may", 4],
  ["jun", 5],
  ["jul", 6],
  ["aug", 7],
  ["sep", 8],
  ["oct", 9],
  ["nov", 10],
  ["dec", 11],
]);

export async function applyRecallPostProcessing(params: {
  query: string;
  results: MemorySearchResult[];
  recall?: ResolvedQmdConfig["recall"];
  now?: Date;
  resolveAbsolutePath?: (relPath: string) => string | null;
}): Promise<MemorySearchResult[]> {
  const recall = params.recall;
  if (!recall) {
    return params.results;
  }
  const mmrEnabled = Boolean(recall.mmr?.enabled);
  const decayEnabled = Boolean(recall.temporalDecay?.enabled);
  const metricsEnabled = Boolean(recall.metrics?.enabled);
  if (!mmrEnabled && !decayEnabled && !metricsEnabled) {
    return params.results;
  }

  const now = params.now ?? new Date();
  const baseResults = params.results.map((entry) => ({ ...entry }));
  const metrics: RecallMetricsSnapshot = {
    query: params.query,
    totalResults: baseResults.length,
    applied: {
      temporalDecay: decayEnabled,
      mmr: mmrEnabled,
    },
    scores: {
      base: baseResults.map((entry) => entry.score),
      afterTemporalDecay: baseResults.map((entry) => entry.score),
      afterMmr: baseResults.map((entry) => entry.score),
    },
  };

  let next = baseResults;

  if (decayEnabled) {
    const halfLifeDays = Math.max(1, recall.temporalDecay?.halfLifeDays ?? 30);
    const decayInfo = await applyTemporalDecay(next, {
      now,
      halfLifeDays,
      resolveAbsolutePath: params.resolveAbsolutePath,
    });
    next = decayInfo.results;
    metrics.scores.afterTemporalDecay = next.map((entry) => entry.score);
    metrics.temporalDecay = {
      halfLifeDays,
      evergreenPaths: decayInfo.evergreen,
      datedPaths: decayInfo.dated,
      mtimeFallbacks: decayInfo.mtimeFallbacks,
    };
  }

  if (mmrEnabled) {
    const lambda = clamp01(recall.mmr?.lambda ?? 0.7);
    next = applyMmr(next, lambda);
    metrics.scores.afterMmr = next.map((entry) => entry.score);
    metrics.mmr = { lambda };
  }

  if (metricsEnabled) {
    await writeRecallMetrics(metrics, recall.metrics ?? { enabled: true, sampleRate: 1 });
  }

  return next;
}

async function applyTemporalDecay(
  results: MemorySearchResult[],
  params: { now: Date; halfLifeDays: number; resolveAbsolutePath?: (relPath: string) => string | null },
): Promise<{
  results: MemorySearchResult[];
  evergreen: number;
  dated: number;
  mtimeFallbacks: number;
}> {
  const lambda = Math.log(2) / params.halfLifeDays;
  let evergreen = 0;
  let dated = 0;
  let mtimeFallbacks = 0;
  const updated = await Promise.all(
    results.map(async (entry) => {
      const info = await resolveDatedPath(entry.path, params.now, params.resolveAbsolutePath);
      if (!info || info.evergreen) {
        evergreen += 1;
        return entry;
      }
      if (info.source === "mtime") {
        mtimeFallbacks += 1;
      }
      dated += 1;
      const ageDays = Math.max(0, (params.now.getTime() - info.date.getTime()) / 86_400_000);
      const decayedScore = entry.score * Math.exp(-lambda * ageDays);
      return { ...entry, score: decayedScore };
    }),
  );

  const sorted = updated.toSorted((a, b) => b.score - a.score);
  return { results: sorted, evergreen, dated, mtimeFallbacks };
}

async function resolveDatedPath(
  pathValue: string,
  now: Date,
  resolveAbsolutePath?: (relPath: string) => string | null,
): Promise<DatedPathInfo | null> {
  if (!pathValue) {
    return null;
  }
  const absPath = resolveAbsolutePath ? resolveAbsolutePath(pathValue) : null;
  const normalizedRel = pathValue.replace(/\\\\/g, "/");
  const normalizedAbs = absPath ? absPath.replace(/\\\\/g, "/") : null;
  const candidatePath = normalizedAbs ?? normalizedRel;

  if (isEvergreenPath(candidatePath)) {
    return { date: now, evergreen: true, source: "none" };
  }
  const dailyMatch = DAILY_FILE_RE.exec(candidatePath);
  if (dailyMatch?.[1]) {
    const date = parseDateToken(dailyMatch[1]);
    if (date) {
      return { date, evergreen: false, source: "filename" };
    }
  }
  if (!absPath) {
    return null;
  }
  try {
    const stat = await fs.stat(absPath);
    return { date: stat.mtime, evergreen: false, source: "mtime" };
  } catch {
    return null;
  }
}

function isEvergreenPath(pathValue: string): boolean {
  const normalized = pathValue.replace(/\\\\/g, "/");
  if (normalized.endsWith("/MEMORY.md") || normalized === "MEMORY.md") {
    return true;
  }
  if (normalized.includes("/memory/")) {
    if (!DAILY_FILE_RE.test(normalized)) {
      return true;
    }
  }
  return false;
}

function parseDateToken(input: string): Date | null {
  const trimmed = input.trim();
  const iso = /^\d{4}-\d{2}-\d{2}$/;
  if (iso.test(trimmed)) {
    const [year, month, day] = trimmed.split("-").map((value) => Number(value));
    if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) {
      return null;
    }
    return new Date(Date.UTC(year, month - 1, day));
  }
  const parts = trimmed.split(/\s+/);
  if (parts.length >= 2) {
    const monthToken = parts[0]?.slice(0, 3).toLowerCase() ?? "";
    const month = MONTHS.get(monthToken);
    const day = Number(parts[1]);
    const year = parts.length >= 3 ? Number(parts[2]) : undefined;
    if (month !== undefined && Number.isFinite(day) && day > 0) {
      const fullYear = Number.isFinite(year) ? year! : new Date().getUTCFullYear();
      return new Date(Date.UTC(fullYear, month, day));
    }
  }
  return null;
}

function applyMmr(results: MemorySearchResult[], lambda: number): MemorySearchResult[] {
  if (results.length <= 2) {
    return results;
  }
  const scored = results.map((entry) => ({
    entry,
    tokens: tokenize(entry.snippet),
    relevance: entry.score,
  }));
  const selected: typeof scored = [];
  const remaining = [...scored];

  while (remaining.length > 0) {
    let bestIndex = 0;
    let bestScore = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < remaining.length; i += 1) {
      const candidate = remaining[i]!;
      const maxSimilarity = selected.length
        ? Math.max(
            ...selected.map((pick) => jaccardSimilarity(candidate.tokens, pick.tokens)),
          )
        : 0;
      const score = lambda * candidate.relevance - (1 - lambda) * maxSimilarity;
      if (score > bestScore) {
        bestScore = score;
        bestIndex = i;
      }
    }
    const [picked] = remaining.splice(bestIndex, 1);
    if (picked) {
      selected.push(picked);
    }
  }

  return selected.map((item) => item.entry);
}

function tokenize(value: string): Set<string> {
  const tokens = new Set<string>();
  const normalized = value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
  if (!normalized) {
    return tokens;
  }
  for (const token of normalized.split(/\s+/)) {
    if (token) {
      tokens.add(token);
    }
  }
  return tokens;
}

function jaccardSimilarity(left: Set<string>, right: Set<string>): number {
  if (!left.size && !right.size) {
    return 0;
  }
  let intersection = 0;
  for (const token of left) {
    if (right.has(token)) {
      intersection += 1;
    }
  }
  const union = left.size + right.size - intersection;
  if (!union) {
    return 0;
  }
  return intersection / union;
}

function clamp01(value: number): number {
  if (Number.isNaN(value)) {
    return 0;
  }
  return Math.max(0, Math.min(1, value));
}

async function writeRecallMetrics(
  metrics: RecallMetricsSnapshot,
  config: { enabled?: boolean; sampleRate?: number },
): Promise<void> {
  const sampleRate = clamp01(config.sampleRate ?? 1);
  if (sampleRate <= 0) {
    return;
  }
  if (sampleRate < 1 && Math.random() > sampleRate) {
    return;
  }
  const payload = {
    event: "memory_recall_metrics",
    timestamp: new Date().toISOString(),
    ...metrics,
  };
  const line = `${JSON.stringify(payload)}\\n`;
  const logPath = path.join(process.cwd(), "data", "metrics", "memory-recall.jsonl");
  await fs.mkdir(path.dirname(logPath), { recursive: true });
  await fs.appendFile(logPath, line, "utf-8");
}
