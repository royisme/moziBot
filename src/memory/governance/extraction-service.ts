/**
 * MemoryExtractionService – converts raw turn/reset events into MemoryCandidate[].
 *
 * Responsibilities (per spec §Functional Components §1):
 * - Receive turn/reset events with flat text fields or AgentMessage arrays
 * - Extract structured MemoryCandidate objects
 * - Assign categories, evidence markers, stability, and scope hints
 * - Generate dedupeKey and id via normalization helpers
 * - Write candidates to inbox via MemoryInboxStore
 *
 * Extraction is rule-based in v1 (Phase 1). LLM-assisted extraction is a v2 enhancement.
 *
 * Secret filtering uses the same patterns as the legacy memory-maintainer to ensure
 * behavioral consistency during the transition period.
 */

import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { logger } from "../../logger";
import type { MemoryInboxStore } from "./inbox-store";
import { buildCandidate } from "./normalization";
import type { MemoryCandidate, MemoryCandidateSource } from "./types";

// ---------------------------------------------------------------------------
// Secret filtering (kept in sync with memory-maintainer constants)
// ---------------------------------------------------------------------------

const SECRET_PATTERNS: RegExp[] = [
  /sk-[A-Za-z0-9_-]{16,}/,
  /bot\d{8,}:[A-Za-z0-9_-]{20,}/,
  /(Bearer\s+)[A-Za-z0-9._-]{16,}/i,
  /tvly-[A-Za-z0-9_-]{16,}/i,
];

const MAX_LINE_CHARS = 240;

/** Returns true when the text contains a secret-like token. */
export function containsSecret(value: string): boolean {
  return SECRET_PATTERNS.some((re) => re.test(value));
}

// ---------------------------------------------------------------------------
// Text normalization (mirrors memory-maintainer normalizeText)
// ---------------------------------------------------------------------------

function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function detectExplicitPreference(text: string): string | null {
  const normalized = normalizeText(text);
  if (!normalized) {
    return null;
  }
  if (/^prefer\s+/i.test(normalized)) {
    return normalized;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Line extraction from flat text fields (turn_completed path)
// ---------------------------------------------------------------------------

/**
 * Extract a clean summary line from turn text fields.
 *
 * Returns null when the text is empty, contains a secret, or is a command
 * (starts with "/").
 */
function extractLineFromText(text: string | undefined): string | null {
  if (!text) {
    return null;
  }
  const normalized = normalizeText(text);
  if (!normalized) {
    return null;
  }
  if (normalized.startsWith("/")) {
    return null;
  }
  if (containsSecret(normalized)) {
    return null;
  }
  return normalized.length > MAX_LINE_CHARS
    ? `${normalized.slice(0, MAX_LINE_CHARS)}...`
    : normalized;
}

/**
 * Render message content (string or content-block array) to plain text.
 * Mirrors the renderMessageText helper in the legacy memory-maintainer.
 */
export function renderMessageText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((part) => {
      if (part && typeof part === "object" && "text" in part && typeof part.text === "string") {
        return part.text;
      }
      return "";
    })
    .join("");
}

// ---------------------------------------------------------------------------
// Candidate extraction from turn_completed data
// ---------------------------------------------------------------------------

const TURNS_TO_KEEP = 10;

/**
 * Extract MemoryCandidates from a completed turn's flat text fields.
 *
 * Each non-empty, non-secret field becomes a separate candidate with
 * `system_observed` evidence. The combined summary captures the Q+A pair.
 */
export function extractFromTurn(params: {
  userText?: string;
  replyText?: string;
  agentId: string;
  sessionId?: string;
  ts?: string;
}): MemoryCandidate[] {
  const ts = params.ts ?? new Date().toISOString();
  const candidates: MemoryCandidate[] = [];

  const userLine = extractLineFromText(params.userText);
  const replyLine = extractLineFromText(params.replyText);

  if (!userLine && !replyLine) {
    return candidates;
  }

  // Build a combined summary from the available lines
  const parts: string[] = [];
  if (userLine) {
    parts.push(`User: ${userLine}`);
  }
  if (replyLine) {
    parts.push(`Assistant: ${replyLine}`);
  }
  const summary = parts.join(" | ");

  candidates.push(
    buildCandidate({
      ts,
      agentId: params.agentId,
      sessionId: params.sessionId,
      source: "turn_completed",
      category: "active_work",
      summary,
      evidence: ["system_observed"],
      confidence: 0.55,
      stability: "low",
      scopeHint: "daily",
      promoteCandidate: false,
      status: "pending",
    }),
  );

  return candidates;
}

// ---------------------------------------------------------------------------
// Candidate extraction from AgentMessage arrays (before_reset path)
// ---------------------------------------------------------------------------

/**
 * Extract MemoryCandidates from a message array (before_reset / pre_compact).
 *
 * Takes the last N user+assistant messages, filters secrets and commands,
 * clips long content, and produces one candidate per qualifying exchange pair,
 * or individual candidates for unpaired messages.
 */
export function extractFromMessages(params: {
  messages: AgentMessage[] | undefined;
  source: MemoryCandidateSource;
  agentId: string;
  sessionId?: string;
  ts?: string;
  maxMessages?: number;
}): MemoryCandidate[] {
  const { messages, source, agentId, sessionId } = params;
  const ts = params.ts ?? new Date().toISOString();
  const maxMessages = params.maxMessages ?? TURNS_TO_KEEP;

  if (!messages || messages.length === 0) {
    return [];
  }

  const filtered = messages
    .filter((msg) => msg.role === "user" || msg.role === "assistant")
    .slice(-maxMessages);

  const lines: Array<{ role: "user" | "assistant"; text: string }> = [];
  for (const msg of filtered) {
    const raw = renderMessageText(msg.content).trim();
    if (!raw || raw.startsWith("/")) {
      continue;
    }
    if (containsSecret(raw)) {
      continue;
    }
    const clipped = raw.length > MAX_LINE_CHARS ? `${raw.slice(0, MAX_LINE_CHARS)}...` : raw;
    lines.push({ role: msg.role, text: clipped });
  }

  if (lines.length === 0) {
    return [];
  }

  const explicitPreference = lines.find((line) => line.role === "user")?.text;
  const detectedPreference = explicitPreference
    ? detectExplicitPreference(explicitPreference)
    : null;
  if (detectedPreference) {
    return [
      buildCandidate({
        ts,
        agentId,
        sessionId,
        source,
        category: "preference",
        summary: detectedPreference,
        evidence: ["user_explicit"],
        confidence: 0.9,
        stability: "high",
        scopeHint: "long_term_candidate",
        promoteCandidate: true,
        status: "pending",
      }),
    ];
  }

  // Pair user+assistant lines into exchange summaries
  const candidates: MemoryCandidate[] = [];
  let i = 0;
  while (i < lines.length) {
    const current = lines[i];
    const next = lines[i + 1];

    let summary: string;
    if (current.role === "user" && next?.role === "assistant") {
      summary = `User: ${current.text} | Assistant: ${next.text}`;
      i += 2;
    } else {
      const prefix = current.role === "user" ? "User" : "Assistant";
      summary = `${prefix}: ${current.text}`;
      i += 1;
    }

    candidates.push(
      buildCandidate({
        ts,
        agentId,
        sessionId,
        source,
        category: "active_work",
        summary,
        evidence: ["system_observed"],
        confidence: 0.55,
        stability: "low",
        scopeHint: "daily",
        promoteCandidate: false,
        status: "pending",
      }),
    );
  }

  return candidates;
}

// ---------------------------------------------------------------------------
// MemoryExtractionService
// ---------------------------------------------------------------------------

export interface ExtractionResult {
  candidates: MemoryCandidate[];
  /** Number of candidates successfully written to the inbox. */
  written: number;
}

export class MemoryExtractionService {
  constructor(private readonly inbox: MemoryInboxStore) {}

  /**
   * Extract candidates from a completed turn and submit to the inbox.
   *
   * Used by the turn_completed hook. The turn event only has flat text fields
   * (userText, replyText) so extraction uses the flat-text path.
   */
  async extractFromTurnAndSubmit(params: {
    userText?: string;
    replyText?: string;
    agentId: string;
    sessionId?: string;
    ts?: string;
  }): Promise<ExtractionResult> {
    const candidates = extractFromTurn(params);
    return this._submitCandidates(candidates, "turn_completed", params.agentId);
  }

  /**
   * Extract candidates from a message array and submit to the inbox.
   *
   * Used by the before_reset hook. The reset event has full AgentMessage[]
   * so extraction uses the message-array path.
   */
  async extractFromMessagesAndSubmit(params: {
    messages: AgentMessage[] | undefined;
    source: MemoryCandidateSource;
    agentId: string;
    sessionId?: string;
    ts?: string;
    maxMessages?: number;
  }): Promise<ExtractionResult> {
    const candidates = extractFromMessages(params);
    return this._submitCandidates(candidates, params.source, params.agentId);
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  private async _submitCandidates(
    candidates: MemoryCandidate[],
    source: MemoryCandidateSource,
    agentId: string,
  ): Promise<ExtractionResult> {
    if (candidates.length === 0) {
      return { candidates: [], written: 0 };
    }

    try {
      await this.inbox.appendMany(candidates);
      logger.debug(
        { agentId, source, count: candidates.length },
        "MemoryExtractionService: candidates submitted to inbox",
      );
      return { candidates, written: candidates.length };
    } catch (error) {
      logger.warn(
        { error, agentId, source, count: candidates.length },
        "MemoryExtractionService: inbox write failed",
      );
      return { candidates, written: 0 };
    }
  }
}
