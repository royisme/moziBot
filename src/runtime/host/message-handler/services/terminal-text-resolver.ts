export interface TerminalTextResolveInput {
  finalReplyText?: string;
  recoveredReplyText?: string;
  streamedReplyText?: string;
}

export type TerminalReplySource =
  | "none"
  | "final_only"
  | "recovered_only"
  | "streamed_only"
  | "final_over_recovered"
  | "final_over_streamed"
  | "final_over_recovered_and_streamed"
  | "recovered_over_streamed";

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
 * - Recovered latest assistant text from session state is the next fallback when final text is unavailable.
 * - Streamed delta accumulation is only used when neither final nor recovered assistant text is available.
 * - Recovered assistant text is treated as raw content and still goes through normal terminal rendering downstream.
 */
export function resolveTerminalReplyDecision(
  input: TerminalTextResolveInput,
): TerminalReplyDecision {
  const finalText = normalize(input.finalReplyText);
  const recoveredText = normalize(input.recoveredReplyText);
  const streamed = normalize(input.streamedReplyText);

  if (!finalText && !recoveredText && !streamed) {
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
      source: recoveredText
        ? streamed
          ? "final_over_recovered_and_streamed"
          : "final_over_recovered"
        : streamed
          ? "final_over_streamed"
          : "final_only",
      finalChars: finalText.length,
      streamedChars: streamed.length,
    };
  }

  if (recoveredText) {
    return {
      text: recoveredText,
      source: streamed ? "recovered_over_streamed" : "recovered_only",
      finalChars: 0,
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
