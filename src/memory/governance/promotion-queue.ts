import type { MemoryCandidate } from "./types";
import { LONG_TERM_CANDIDATE_CATEGORIES, DAILY_AND_PROMOTABLE_CATEGORIES } from "./types";

function compareCandidates(a: MemoryCandidate, b: MemoryCandidate): number {
  const ts = a.ts.localeCompare(b.ts);
  if (ts !== 0) return ts;
  const category = a.category.localeCompare(b.category);
  if (category !== 0) return category;
  return a.id.localeCompare(b.id);
}

export class PromotionQueue {
  select(candidates: MemoryCandidate[]): MemoryCandidate[] {
    return candidates
      .filter((candidate) => {
        if (candidate.status !== "pending" && candidate.status !== "accepted_daily") {
          return false;
        }
        if (!candidate.promoteCandidate) {
          return false;
        }
        return (
          LONG_TERM_CANDIDATE_CATEGORIES.has(candidate.category) ||
          DAILY_AND_PROMOTABLE_CATEGORIES.has(candidate.category)
        );
      })
      .toSorted(compareCandidates);
  }
}
