export const SNIPPET_HEADER_RE = /@@\s*-([0-9]+),([0-9]+)/;

export function extractSnippetLines(snippet: string): {
  startLine: number;
  endLine: number;
} {
  const match = SNIPPET_HEADER_RE.exec(snippet);
  if (match) {
    const start = Number(match[1]);
    const count = Number(match[2]);
    if (Number.isFinite(start) && Number.isFinite(count)) {
      return { startLine: start, endLine: start + count - 1 };
    }
  }
  const lines = snippet.split("\n").length;
  return { startLine: 1, endLine: lines };
}

export function clampResultsByInjectedChars<T extends { snippet?: string }>(
  results: T[],
  budget: number,
): T[] {
  if (!budget || budget <= 0) {
    return results;
  }
  let remaining = budget;
  const clamped: T[] = [];
  for (const entry of results) {
    if (remaining <= 0) {
      break;
    }
    const snippet = entry.snippet ?? "";
    if (snippet.length <= remaining) {
      clamped.push(entry);
      remaining -= snippet.length;
    } else {
      const trimmed = snippet.slice(0, Math.max(0, remaining));
      clamped.push({ ...entry, snippet: trimmed });
      break;
    }
  }
  return clamped;
}
