/**
 * Production-safe file I/O helpers for the memory governance pipeline.
 *
 * Design principles:
 * - Atomic writes via temp-file + rename (prevents partial-write corruption).
 * - Append-only helpers that tolerate missing files (crash-safe inbox).
 * - Uses node:fs/promises so the module works under both Bun and Vitest/Node.
 */

import { randomBytes } from "node:crypto";
import { mkdir, rename, unlink, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

// ---------------------------------------------------------------------------
// Directory helpers
// ---------------------------------------------------------------------------

/**
 * Ensure a directory (and all parents) exists.
 * Equivalent to `mkdir -p`.
 */
export async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

// ---------------------------------------------------------------------------
// Atomic write
// ---------------------------------------------------------------------------

/**
 * Write `content` to `targetPath` atomically.
 *
 * Writes to a sibling temp file first, then renames into place.
 * If any step fails the original file is left intact.
 */
export async function atomicWrite(targetPath: string, content: string): Promise<void> {
  const dir = dirname(targetPath);
  await ensureDir(dir);

  const suffix = randomBytes(6).toString("hex");
  const tmpPath = `${targetPath}.${suffix}.tmp`;

  try {
    await writeFile(tmpPath, content, "utf8");
    await rename(tmpPath, targetPath);
  } catch (err) {
    try {
      await unlink(tmpPath);
    } catch {
      // ignore cleanup failure
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// JSONL helpers
// ---------------------------------------------------------------------------

/**
 * Read all records from a JSONL file.
 *
 * Returns an empty array when the file does not exist.
 * Skips blank lines. Throws on malformed JSON (fail-fast for debugging).
 */
export async function readJsonlFile<T>(filePath: string): Promise<T[]> {
  let text: string;
  try {
    text = await readFile(filePath, "utf8");
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw err;
  }

  const results: T[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) {
      continue;
    }
    results.push(JSON.parse(line) as T);
  }
  return results;
}

/**
 * Rewrite an entire JSONL file from an in-memory array.
 * Uses `atomicWrite` so the file is never left in a partial state.
 */
export async function rewriteJsonlFile<T>(filePath: string, records: T[]): Promise<void> {
  const content = records.map((r) => JSON.stringify(r)).join("\n");
  await atomicWrite(filePath, content ? content + "\n" : "");
}
