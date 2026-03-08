import type { CandidateStatus, MemoryCandidate } from "./types";
import { DAILY_ALLOWED_CATEGORIES, DAILY_ONLY_CATEGORIES } from "./types";

type DailySectionCategory =
  | "active_work"
  | "blocker"
  | "todo"
  | "decision"
  | "lesson"
  | "preference"
  | "tooling_fact";

const DAILY_SECTION_ORDER: DailySectionCategory[] = [
  "active_work",
  "blocker",
  "todo",
  "decision",
  "lesson",
  "preference",
  "tooling_fact",
];

const DAILY_SECTION_TITLES: Record<DailySectionCategory, string> = {
  active_work: "Active Work",
  blocker: "Blockers",
  todo: "Todos",
  decision: "Decisions",
  lesson: "Lessons",
  preference: "Preferences",
  tooling_fact: "Tooling Facts",
};

const INCLUDED_STATUSES: ReadonlySet<CandidateStatus> = new Set(["accepted_daily", "promoted"]);

export interface DailyCompilationResult {
  date: string;
  candidates: MemoryCandidate[];
  markdown: string;
}

function compareCandidates(a: MemoryCandidate, b: MemoryCandidate): number {
  const ts = a.ts.localeCompare(b.ts);
  if (ts !== 0) return ts;
  const category = a.category.localeCompare(b.category);
  if (category !== 0) return category;
  const summary = a.summary.localeCompare(b.summary);
  if (summary !== 0) return summary;
  return a.id.localeCompare(b.id);
}

function normalizeDate(ts: string): string {
  return new Date(ts).toISOString().slice(0, 10);
}

function includeCandidate(candidate: MemoryCandidate, date: string): boolean {
  if (!candidate.status || !INCLUDED_STATUSES.has(candidate.status)) {
    return false;
  }

  if (normalizeDate(candidate.ts) !== date) {
    return false;
  }

  if (!DAILY_ALLOWED_CATEGORIES.has(candidate.category)) {
    return false;
  }

  if (candidate.status === "promoted" && DAILY_ONLY_CATEGORIES.has(candidate.category)) {
    return false;
  }

  return true;
}

function dedupeCandidates(candidates: MemoryCandidate[]): MemoryCandidate[] {
  const sorted = candidates.toSorted(compareCandidates);
  const seen = new Set<string>();
  const deduped: MemoryCandidate[] = [];
  for (const candidate of sorted) {
    if (seen.has(candidate.dedupeKey)) {
      continue;
    }
    seen.add(candidate.dedupeKey);
    deduped.push(candidate);
  }
  return deduped;
}

export class DailyMemoryCompiler {
  compile(params: { date: string; candidates: MemoryCandidate[] }): DailyCompilationResult {
    const filtered = dedupeCandidates(
      params.candidates.filter((candidate) => includeCandidate(candidate, params.date)),
    );

    const sections = DAILY_SECTION_ORDER.map((category) => ({
      title: DAILY_SECTION_TITLES[category],
      items: filtered.filter((candidate) => candidate.category === category),
    })).filter((section) => section.items.length > 0);

    const orderedCandidates = sections.flatMap((section) => section.items);

    const body = sections
      .map(
        (section) =>
          `## ${section.title}\n\n${section.items.map((candidate) => `- ${candidate.summary}`).join("\n")}`,
      )
      .join("\n\n");

    const markdown = body ? `# Daily Memory ${params.date}\n\n${body}\n` : `# Daily Memory ${params.date}\n`;

    return {
      date: params.date,
      candidates: orderedCandidates,
      markdown,
    };
  }
}
