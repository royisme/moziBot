import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { MoziConfig } from "../../config";
import { logger } from "../../logger";

export type SessionExporterConfig = {
  dir: string;
  retentionMs?: number;
  collectionName: string;
};

type SessionFileEntry = {
  absPath: string;
  mtimeMs: number;
  content: string;
};

export async function exportSessions(params: {
  config: MoziConfig;
  agentId: string;
  exporter: SessionExporterConfig;
}): Promise<void> {
  const exportDir = params.exporter.dir;
  await fs.mkdir(exportDir, { recursive: true });
  const files = await listSessionFilesForAgent(params.config, params.agentId);
  const keep = new Set<string>();
  const cutoff = params.exporter.retentionMs ? Date.now() - params.exporter.retentionMs : null;
  let exportedCount = 0;
  let prunedCount = 0;

  for (const sessionFile of files) {
    const entry = await buildSessionEntry(sessionFile);
    if (!entry) {
      continue;
    }
    if (cutoff && entry.mtimeMs < cutoff) {
      continue;
    }
    const target = path.join(exportDir, `${path.basename(sessionFile, ".jsonl")}.md`);
    await fs.writeFile(target, renderSessionMarkdown(entry), "utf-8");
    keep.add(target);
    exportedCount++;
  }
  const exported = await fs.readdir(exportDir).catch(() => []);
  for (const name of exported) {
    if (!name.endsWith(".md")) {
      continue;
    }
    const full = path.join(exportDir, name);
    if (!keep.has(full)) {
      await fs.rm(full, { force: true });
      prunedCount++;
    }
  }

  logger.info(
    {
      event: "session_export",
      agentId: params.agentId,
      exported: exportedCount,
      pruned: prunedCount,
      total: files.length,
      dir: exportDir,
    },
    `exported ${exportedCount} sessions to ${exportDir} (pruned ${prunedCount})`,
  );
}

export function pickSessionCollectionName(existing: string[]): string {
  const existingSet = new Set(existing);
  if (!existingSet.has("sessions")) {
    return "sessions";
  }
  let counter = 2;
  let candidate = `sessions-${counter}`;
  while (existingSet.has(candidate)) {
    counter += 1;
    candidate = `sessions-${counter}`;
  }
  return candidate;
}

function renderSessionMarkdown(entry: SessionFileEntry): string {
  const header = `# Session ${path.basename(entry.absPath, path.extname(entry.absPath))}`;
  const body = entry.content?.trim().length ? entry.content.trim() : "(empty)";
  return `${header}\n\n${body}\n`;
}

async function listSessionFilesForAgent(config: MoziConfig, agentId: string): Promise<string[]> {
  let baseDir = config.paths?.sessions;
  if (!baseDir) {
    baseDir = path.join(os.tmpdir(), "mozi", "sessions");
  }
  if (!path.isAbsolute(baseDir)) {
    if (config.paths?.baseDir) {
      baseDir = path.resolve(config.paths.baseDir, baseDir);
    } else {
      baseDir = path.resolve(baseDir);
    }
  }
  const dir = path.join(baseDir, agentId);
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .filter((name) => name.endsWith(".jsonl"))
      .map((name) => path.join(dir, name));
  } catch {
    return [];
  }
}

function normalizeSessionText(value: string): string {
  return value
    .replace(/\s*\n+\s*/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractSessionText(content: unknown): string | null {
  if (typeof content === "string") {
    const normalized = normalizeSessionText(content);
    return normalized ? normalized : null;
  }
  if (!Array.isArray(content)) {
    return null;
  }
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const record = block as { type?: unknown; text?: unknown };
    if (record.type !== "text" || typeof record.text !== "string") {
      continue;
    }
    const normalized = normalizeSessionText(record.text);
    if (normalized) {
      parts.push(normalized);
    }
  }
  if (parts.length === 0) {
    return null;
  }
  return parts.join(" ");
}

async function buildSessionEntry(absPath: string): Promise<SessionFileEntry | null> {
  try {
    const stat = await fs.stat(absPath);
    const raw = await fs.readFile(absPath, "utf-8");
    const lines = raw.split("\n");
    const collected: string[] = [];
    for (const line of lines) {
      if (!line.trim()) {
        continue;
      }
      let record: unknown;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      if (!record || typeof record !== "object") {
        continue;
      }
      const type = (record as { type?: unknown }).type;
      if (type !== "message") {
        continue;
      }
      const message = (record as { message?: unknown }).message as
        | { role?: unknown; content?: unknown }
        | undefined;
      if (!message || typeof message.role !== "string") {
        continue;
      }
      if (message.role !== "user" && message.role !== "assistant") {
        continue;
      }
      const text = extractSessionText(message.content);
      if (!text) {
        continue;
      }
      const label = message.role === "user" ? "User" : "Assistant";
      collected.push(`${label}: ${text}`);
    }
    const content = collected.join("\n");
    return {
      absPath,
      mtimeMs: stat.mtimeMs,
      content,
    };
  } catch {
    return null;
  }
}
