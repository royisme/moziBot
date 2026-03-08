/**
 * Normalization helpers for the memory governance pipeline.
 *
 * These functions are used when generating dedupeKeys and when comparing
 * candidate summaries for Level-1 fast dedupe.
 *
 * All functions are pure and have no side-effects.
 */

import { createHash } from "node:crypto";
import type { MemoryCandidate, MemoryCandidateCategory } from "./types";

// ---------------------------------------------------------------------------
// Discourse prefix patterns stripped during normalization
// ---------------------------------------------------------------------------

const DISCOURSE_PREFIXES = [
  /^user said[:\s]+/i,
  /^assistant noted[:\s]+/i,
  /^assistant said[:\s]+/i,
  /^i noted[:\s]+/i,
  /^note[:\s]+/i,
  /^reminder[:\s]+/i,
  /^summary[:\s]+/i,
  /^update[:\s]+/i,
  /^follow[- ]?up[:\s]+/i,
  /^fyi[:\s]+/i,
];

// Date / timestamp fragments that are volatile and should be stripped
const DATE_FRAGMENT_RE =
  /\b\d{4}[-/]\d{2}[-/]\d{2}(T\d{2}:\d{2}(:\d{2})?Z?)?\b/g;

// Standalone numbers that are likely ephemeral (e.g. line counts, session IDs)
const VOLATILE_NUMBER_RE = /\b\d{5,}\b/g;

// ---------------------------------------------------------------------------
// Core normalization
// ---------------------------------------------------------------------------

/**
 * Normalize a candidate summary for deduplication purposes.
 *
 * Rules (applied in order):
 * 1. Lowercase
 * 2. Strip discourse prefixes
 * 3. Collapse whitespace
 * 4. Strip date/timestamp fragments
 * 5. Strip volatile large numeric fragments
 * 6. Trim
 */
export function normalizeSummary(raw: string): string {
  let s = raw.toLowerCase();

  for (const re of DISCOURSE_PREFIXES) {
    s = s.replace(re, "");
  }

  s = s.replace(DATE_FRAGMENT_RE, "");
  s = s.replace(VOLATILE_NUMBER_RE, "");

  // Collapse whitespace (including newlines)
  s = s.replace(/\s+/g, " ").trim();

  return s;
}

// ---------------------------------------------------------------------------
// Dedupe key generation
// ---------------------------------------------------------------------------

/**
 * Generate a deterministic Level-1 dedupe key from candidate fields.
 *
 * Key inputs (per spec):
 * - category
 * - normalized summary
 * - normalized target scope (scopeHint)
 * - agentId
 *
 * Including scopeHint ensures that the same fact emitted for daily use vs.
 * long-term candidacy does not collide, which the spec treats as separate layers.
 *
 * The key is a short SHA-256 hex prefix (16 chars) so it is compact and
 * safe for file-system use if ever used as a shard key.
 */
export function generateDedupeKey(
  category: MemoryCandidateCategory,
  summary: string,
  agentId: string,
  scopeHint: string
): string {
  const normalized = normalizeSummary(summary);
  const raw = `${category}::${normalized}::${agentId}::${scopeHint}`;
  return createHash("sha256").update(raw).digest("hex").slice(0, 16);
}

// ---------------------------------------------------------------------------
// Candidate ID generation
// ---------------------------------------------------------------------------

/**
 * Generate a deterministic candidate ID.
 *
 * The ID is derived from the dedupeKey and the truncated ISO timestamp (day
 * precision) so candidates with the same content on the same day share the
 * same ID – making inbox writes idempotent by default.
 *
 * Source is intentionally excluded: the same candidate content on the same day
 * must produce the same ID regardless of which pipeline entry point emitted it
 * (turn_completed, before_reset, pre_compact). This is the cross-path idempotency
 * guarantee required by the spec.
 */
export function generateCandidateId(
  dedupeKey: string,
  ts: string
): string {
  // Truncate to day precision so same-day duplicates collide
  const day = ts.slice(0, 10);
  const raw = `${dedupeKey}::${day}`;
  return createHash("sha256").update(raw).digest("hex").slice(0, 24);
}

// ---------------------------------------------------------------------------
// Transcript-like detection heuristics
// ---------------------------------------------------------------------------

/**
 * Returns true when the text looks like a raw conversation excerpt rather than
 * a structured fact or rule.  Used by the policy engine for hard rejection.
 */
export function isTranscriptLike(text: string): boolean {
  const lower = text.toLowerCase();

  // Strong signal: repeated speaker labels
  const userMatches = (lower.match(/\buser\s*:/g) ?? []).length;
  const assistantMatches = (lower.match(/\bassistant\s*:/g) ?? []).length;
  if (userMatches >= 2 || assistantMatches >= 2) return true;
  if (userMatches >= 1 && assistantMatches >= 1) return true;

  // Alternating Q&A patterns
  if (/\bq\s*:\s*.+\ba\s*:/i.test(text)) return true;

  return false;
}

/**
 * Returns true when the text is dominated by URL(s) with no surrounding
 * explanatory text.
 */
export function isUrlDump(text: string): boolean {
  const trimmed = text.trim();
  // Strip all URLs and see what's left
  const withoutUrls = trimmed
    .replace(/https?:\/\/[^\s]+/gi, "")
    .replace(/\s+/g, " ")
    .trim();
  // If almost nothing remains after removing URLs the entry is a URL dump
  const urlCount = (trimmed.match(/https?:\/\/[^\s]+/gi) ?? []).length;
  return urlCount >= 1 && withoutUrls.length < 15;
}

// ---------------------------------------------------------------------------
// Candidate factory helper
// ---------------------------------------------------------------------------

/**
 * Build a fully-formed MemoryCandidate from minimal inputs.
 * Generates id and dedupeKey automatically.
 */
export function buildCandidate(
  partial: Omit<MemoryCandidate, "id" | "dedupeKey"> & {
    id?: string;
    dedupeKey?: string;
  }
): MemoryCandidate {
  const dedupeKey =
    partial.dedupeKey ??
    generateDedupeKey(partial.category, partial.summary, partial.agentId, partial.scopeHint);
  const id =
    partial.id ?? generateCandidateId(dedupeKey, partial.ts);
  return {
    ...partial,
    id,
    dedupeKey,
    status: partial.status ?? "pending",
  };
}
