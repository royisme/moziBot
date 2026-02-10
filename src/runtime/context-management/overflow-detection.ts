/**
 * Error detection utilities for context overflow and compaction failures.
 *
 * Detects context overflow errors from LLM APIs (Anthropic, OpenAI, Google)
 * and distinguishes them from other error types.
 */

// Exclusion pattern for "context window too small" errors
const CONTEXT_WINDOW_TOO_SMALL_RE = /context window.*(too small|minimum is)/i;

// Broad heuristic regex for likely overflow detection
const CONTEXT_OVERFLOW_HINT_RE =
  /context.*overflow|context window.*(too (?:large|long)|exceed|over|limit|max(?:imum)?|requested|sent|tokens)|(?:prompt|request|input).*(too (?:large|long)|exceed|over|limit|max(?:imum)?)/i;

/**
 * Detects known context overflow error patterns from LLM APIs.
 * Supports Anthropic, OpenAI, Google, and generic patterns.
 *
 * Patterns detected:
 * - "request_too_large" (Anthropic)
 * - "request exceeds the maximum size"
 * - "context length exceeded"
 * - "maximum context length"
 * - "prompt is too long"
 * - "exceeds model context window"
 * - "context overflow"
 * - Composite: "request size exceeds" + "context window/length"
 * - "413 too large" (HTTP status)
 *
 * @param errorMessage - The error message to check
 * @returns true if the message matches a known overflow pattern
 */
export function isContextOverflowError(errorMessage?: string): boolean {
  if (!errorMessage) {
    return false;
  }

  const lower = errorMessage.toLowerCase();

  // Check composite pattern: "request size exceeds" + context-related terms
  const hasRequestSizeExceeds = lower.includes("request size exceeds");
  const hasContextWindow =
    lower.includes("context window") ||
    lower.includes("context length") ||
    lower.includes("maximum context length");

  return (
    lower.includes("request_too_large") ||
    lower.includes("request exceeds the maximum size") ||
    lower.includes("context length exceeded") ||
    lower.includes("maximum context length") ||
    lower.includes("prompt is too long") ||
    lower.includes("exceeds model context window") ||
    (hasRequestSizeExceeds && hasContextWindow) ||
    lower.includes("context overflow") ||
    (lower.includes("413") && lower.includes("too large"))
  );
}

/**
 * Broader heuristic for detecting context overflow errors.
 * Uses regex patterns for cases not caught by exact matching.
 *
 * Excludes "context window too small" / "minimum is" patterns
 * which indicate a different error (context window configuration issue).
 *
 * Falls back to isContextOverflowError first, then tries CONTEXT_OVERFLOW_HINT_RE.
 *
 * @param errorMessage - The error message to check
 * @returns true if the message likely indicates a context overflow
 */
export function isLikelyContextOverflowError(errorMessage?: string): boolean {
  if (!errorMessage) {
    return false;
  }

  // Exclude "context window too small" errors first
  if (CONTEXT_WINDOW_TOO_SMALL_RE.test(errorMessage)) {
    return false;
  }

  // Check exact patterns first
  if (isContextOverflowError(errorMessage)) {
    return true;
  }

  // Try heuristic pattern
  return CONTEXT_OVERFLOW_HINT_RE.test(errorMessage);
}

/**
 * Detects if an error is a compaction failure.
 * Returns true only if isContextOverflowError is true AND
 * the message contains compaction-related keywords.
 *
 * @param errorMessage - The error message to check
 * @returns true if the message indicates a compaction failure
 */
export function isCompactionFailureError(errorMessage?: string): boolean {
  if (!errorMessage) {
    return false;
  }

  // Must be an overflow error first
  if (!isContextOverflowError(errorMessage)) {
    return false;
  }

  const lower = errorMessage.toLowerCase();

  return (
    lower.includes("summarization failed") ||
    lower.includes("auto-compaction") ||
    lower.includes("compaction failed") ||
    lower.includes("compaction")
  );
}
