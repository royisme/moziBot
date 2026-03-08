import { join } from "node:path";
import { readJsonlFile, rewriteJsonlFile } from "./file-store-utils";
import type { MemoryCandidate } from "./types";
import { DAILY_ONLY_CATEGORIES } from "./types";

export interface LongTermFact {
  id: string;
  candidateId: string;
  ts: string;
  agentId: string;
  category: MemoryCandidate["category"];
  summary: string;
  details?: string;
  dedupeKey: string;
  invalidated?: boolean;
}

function factPath(baseDir: string): string {
  return join(baseDir, "longterm", "facts.jsonl");
}

function compareFacts(a: LongTermFact, b: LongTermFact): number {
  const category = a.category.localeCompare(b.category);
  if (category !== 0) {
    return category;
  }
  const summary = a.summary.localeCompare(b.summary);
  if (summary !== 0) {
    return summary;
  }
  return a.id.localeCompare(b.id);
}

export class LongTermStore {
  constructor(private readonly baseDir: string) {}

  async readAll(): Promise<LongTermFact[]> {
    return readJsonlFile<LongTermFact>(factPath(this.baseDir));
  }

  async appendFromCandidate(candidate: MemoryCandidate): Promise<boolean> {
    if (DAILY_ONLY_CATEGORIES.has(candidate.category)) {
      throw new Error(
        `Daily-only category cannot be promoted to long-term storage: ${candidate.category}`,
      );
    }

    const facts = await this.readAll();
    if (facts.some((fact) => fact.dedupeKey === candidate.dedupeKey && !fact.invalidated)) {
      return false;
    }

    const fact: LongTermFact = {
      id: candidate.id,
      candidateId: candidate.id,
      ts: candidate.ts,
      agentId: candidate.agentId,
      category: candidate.category,
      summary: candidate.summary,
      details: candidate.details,
      dedupeKey: candidate.dedupeKey,
      invalidated: false,
    };

    await rewriteJsonlFile(factPath(this.baseDir), [...facts, fact].toSorted(compareFacts));
    return true;
  }

  async invalidateByDedupeKey(dedupeKey: string): Promise<boolean> {
    const facts = await this.readAll();
    let changed = false;
    const updated = facts.map((fact) => {
      if (fact.dedupeKey !== dedupeKey || fact.invalidated) {
        return fact;
      }
      changed = true;
      return { ...fact, invalidated: true };
    });

    if (!changed) {
      return false;
    }

    await rewriteJsonlFile(factPath(this.baseDir), updated.toSorted(compareFacts));
    return true;
  }
}
