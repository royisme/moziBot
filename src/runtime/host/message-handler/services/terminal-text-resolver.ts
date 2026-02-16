export interface TerminalTextResolveInput {
  finalReplyText?: string;
  streamedReplyText?: string;
}

export type TerminalReplySource = "none" | "final_only" | "streamed_only" | "final_over_streamed";

export interface TerminalReplyDecision {
  text?: string;
  source: TerminalReplySource;
  finalChars: number;
  streamedChars: number;
}

function normalize(text: string | undefined): string {
  return typeof text === "string" ? text.trim() : "";
}

/**
 * Delivery ownership policy:
 * - Final reply text emitted inside the turn (agent_end.fullText) is authoritative.
 * - Streamed delta accumulation is only a fallback when final text is unavailable.
 * - Session snapshot/rendered text is intentionally excluded from ownership.
 */
export function resolveTerminalReplyDecision(
  input: TerminalTextResolveInput,
): TerminalReplyDecision {
  const finalText = normalize(input.finalReplyText);
  const streamed = normalize(input.streamedReplyText);

  if (!finalText && !streamed) {
    return {
      text: undefined,
      source: "none",
      finalChars: 0,
      streamedChars: 0,
    };
  }

  if (finalText) {
    return {
      text: finalText,
      source: streamed ? "final_over_streamed" : "final_only",
      finalChars: finalText.length,
      streamedChars: streamed.length,
    };
  }

  return {
    text: streamed,
    source: "streamed_only",
    finalChars: 0,
    streamedChars: streamed.length,
  };
}

export function resolveTerminalReplyText(input: TerminalTextResolveInput): string | undefined {
  return resolveTerminalReplyDecision(input).text;
}
