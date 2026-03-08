/**
 * MemoryInboxStore – append-only JSONL inbox for MemoryCandidate events.
 *
 * Responsibilities (per spec §Functional Components §2):
 * - Append candidates to `<baseDir>/inbox/YYYY-MM-DD.jsonl`
 * - Enforce idempotent writes by candidate ID (same ID → skip, no duplicate)
 * - Support status updates (mark a candidate's status after policy evaluation)
 * - Support scans by date range and/or status (for downstream compilers)
 *
 * Storage layout:
 *   <baseDir>/inbox/YYYY-MM-DD.jsonl   – one shard per calendar day (UTC)
 *
 * Each line is a full MemoryCandidate JSON object.
 * The file is append-only during normal operation; status updates rewrite the
 * shard atomically so a crash cannot leave the file corrupt.
 */

import { join } from "node:path";
import { readJsonlFile, rewriteJsonlFile, ensureDir } from "./file-store-utils";
import type { MemoryCandidate, CandidateStatus } from "./types";

// ---------------------------------------------------------------------------
// Date helpers (UTC, keeps shards deterministic across timezones)
// ---------------------------------------------------------------------------

/** Format a Date (or ISO string) as "YYYY-MM-DD" in UTC. */
export function toUtcDateString(ts: Date | string): string {
  const d = typeof ts === "string" ? new Date(ts) : ts;
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Enumerate every "YYYY-MM-DD" string in [fromDate, toDate] (inclusive, UTC). */
export function dateRange(fromDate: string, toDate: string): string[] {
  const dates: string[] = [];
  const start = new Date(`${fromDate}T00:00:00Z`);
  const end = new Date(`${toDate}T00:00:00Z`);
  const dayCount = Math.floor((end.getTime() - start.getTime()) / 86_400_000);

  for (let offset = 0; offset <= dayCount; offset += 1) {
    const current = new Date(start);
    current.setUTCDate(start.getUTCDate() + offset);
    dates.push(toUtcDateString(current));
  }
  return dates;
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

function shardPath(baseDir: string, dateStr: string): string {
  return join(baseDir, "inbox", `${dateStr}.jsonl`);
}

// ---------------------------------------------------------------------------
// MemoryInboxStore
// ---------------------------------------------------------------------------

export interface ScanOptions {
  /** Inclusive start date "YYYY-MM-DD" (UTC). Defaults to today. */
  fromDate?: string;
  /** Inclusive end date "YYYY-MM-DD" (UTC). Defaults to today. */
  toDate?: string;
  /** If provided, only return candidates whose status matches. */
  status?: CandidateStatus;
}

export class MemoryInboxStore {
  /**
   * @param baseDir Root memory directory (e.g. `memory/`).
   *   Inbox shards are written under `<baseDir>/inbox/`.
   */
  constructor(private readonly baseDir: string) {}

  // -------------------------------------------------------------------------
  // Write path
  // -------------------------------------------------------------------------

  /**
   * Append a candidate to the inbox shard for its calendar day (UTC).
   *
   * Idempotent: if a candidate with the same `id` already exists in the shard
   * the write is silently skipped (no duplicate, no error).
   *
   * The candidate is written with `status: "pending"` if no status is set.
   */
  async append(candidate: MemoryCandidate): Promise<void> {
    const dateStr = toUtcDateString(candidate.ts);
    const filePath = shardPath(this.baseDir, dateStr);

    // Single read: check idempotency and collect existing content together.
    const existing = await readJsonlFile<MemoryCandidate>(filePath);
    if (existing.some((c) => c.id === candidate.id)) {
      return; // already present – skip
    }

    const record: MemoryCandidate = {
      ...candidate,
      status: candidate.status ?? "pending",
    };
    await rewriteJsonlFile(filePath, [...existing, record]);
  }

  /**
   * Append multiple candidates in one call.
   *
   * Candidates are grouped by their UTC date shard so each shard is read and
   * written at most once, regardless of how many candidates share the same day.
   * Per-ID idempotency applies within each group.
   */
  async appendMany(candidates: MemoryCandidate[]): Promise<void> {
    // Group by shard date to minimise file I/O.
    const byDate = new Map<string, MemoryCandidate[]>();
    for (const c of candidates) {
      const dateStr = toUtcDateString(c.ts);
      const group = byDate.get(dateStr);
      if (group) {
        group.push(c);
      } else {
        byDate.set(dateStr, [c]);
      }
    }

    for (const [dateStr, group] of byDate) {
      const filePath = shardPath(this.baseDir, dateStr);
      const existing = await readJsonlFile<MemoryCandidate>(filePath);
      const existingIds = new Set(existing.map((c) => c.id));

      const toAdd: MemoryCandidate[] = [];
      for (const c of group) {
        if (existingIds.has(c.id)) {
          continue;
        } // idempotent – skip duplicate
        existingIds.add(c.id); // guard against duplicates within the batch
        toAdd.push({ ...c, status: c.status ?? "pending" });
      }

      if (toAdd.length > 0) {
        await rewriteJsonlFile(filePath, [...existing, ...toAdd]);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Status update path
  // -------------------------------------------------------------------------

  /**
   * Update the status (and optional rejectionReason) of a candidate in-place.
   *
   * Rewrites the shard atomically. If the candidate ID is not found in the
   * shard for its date, this is a no-op (returns false).
   *
   * @returns true if the candidate was found and updated, false otherwise.
   */
  async updateStatus(
    candidateId: string,
    candidateTs: string,
    status: CandidateStatus,
    rejectionReason?: string,
  ): Promise<boolean> {
    const dateStr = toUtcDateString(candidateTs);
    const filePath = shardPath(this.baseDir, dateStr);

    const records = await readJsonlFile<MemoryCandidate>(filePath);
    let found = false;

    const updated = records.map((c) => {
      if (c.id !== candidateId) {
        return c;
      }
      found = true;
      return {
        ...c,
        status,
        ...(rejectionReason !== undefined ? { rejectionReason } : {}),
      };
    });

    if (!found) {
      return false;
    }

    await rewriteJsonlFile(filePath, updated);
    return true;
  }

  // -------------------------------------------------------------------------
  // Read / scan path
  // -------------------------------------------------------------------------

  /**
   * Read all candidates from a single date shard (UTC date string "YYYY-MM-DD").
   * Returns an empty array if the shard does not exist.
   */
  async readShard(dateStr: string): Promise<MemoryCandidate[]> {
    return readJsonlFile<MemoryCandidate>(shardPath(this.baseDir, dateStr));
  }

  /**
   * Scan candidates across a date range and optional status filter.
   *
   * Results are returned in shard order (chronological by date, then
   * insertion order within a shard).
   */
  async scan(options: ScanOptions = {}): Promise<MemoryCandidate[]> {
    const today = toUtcDateString(new Date());
    const from = options.fromDate ?? today;
    const to = options.toDate ?? today;

    const dates = dateRange(from, to);
    const shards = await Promise.all(dates.map((d) => this.readShard(d)));

    const results: MemoryCandidate[] = [];
    for (const shard of shards) {
      for (const c of shard) {
        if (options.status === undefined || c.status === options.status) {
          results.push(c);
        }
      }
    }
    return results;
  }

  /**
   * Convenience: return all pending candidates across a date range.
   */
  async scanPending(fromDate?: string, toDate?: string): Promise<MemoryCandidate[]> {
    return this.scan({ fromDate, toDate, status: "pending" });
  }

  // -------------------------------------------------------------------------
  // Init helper
  // -------------------------------------------------------------------------

  /** Ensure the inbox directory exists. Safe to call multiple times. */
  async init(): Promise<void> {
    await ensureDir(join(this.baseDir, "inbox"));
  }
}
