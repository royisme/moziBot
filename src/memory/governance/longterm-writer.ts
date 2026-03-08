import { join } from "node:path";
import { atomicWrite } from "./file-store-utils";
import type { LongTermFact } from "./longterm-store";
import type { MemoryCandidateCategory } from "./types";
import { LONGTERM_SECTION_MAP } from "./types";

const SECTION_ORDER = [
  "User Preferences",
  "Stable Rules",
  "Tooling Facts",
  "Long-term Projects",
  "Repeated Lessons",
] as const;

function getSection(category: MemoryCandidateCategory): string {
  const section = LONGTERM_SECTION_MAP[category];
  if (!section) {
    throw new Error(`Unsupported long-term category: ${category}`);
  }
  return section;
}

function compareFacts(a: LongTermFact, b: LongTermFact): number {
  const sectionA = getSection(a.category);
  const sectionB = getSection(b.category);
  const sectionCmp = sectionA.localeCompare(sectionB);
  if (sectionCmp !== 0) {
    return sectionCmp;
  }
  const summaryCmp = a.summary.localeCompare(b.summary);
  if (summaryCmp !== 0) {
    return summaryCmp;
  }
  return a.id.localeCompare(b.id);
}

export class LongTermMemoryWriter {
  constructor(private readonly homeDir: string) {}

  buildMarkdown(facts: LongTermFact[]): string {
    const activeFacts = facts.filter((fact) => !fact.invalidated);
    const grouped = new Map<string, LongTermFact[]>();

    for (const fact of activeFacts.toSorted(compareFacts)) {
      const section = getSection(fact.category);
      const existing = grouped.get(section);
      if (existing) {
        existing.push(fact);
      } else {
        grouped.set(section, [fact]);
      }
    }

    const sections = SECTION_ORDER.filter((section) => (grouped.get(section)?.length ?? 0) > 0)
      .map(
        (section) =>
          `## ${section}\n\n${grouped
            .get(section)!
            .map((fact) => `- ${fact.summary}`)
            .join("\n")}`,
      )
      .join("\n\n");

    return sections ? `# Memory\n\n${sections}\n` : "# Memory\n";
  }

  async rebuild(facts: LongTermFact[]): Promise<string> {
    const markdown = this.buildMarkdown(facts);
    const targetPath = join(this.homeDir, "MEMORY.md");
    await atomicWrite(targetPath, markdown);
    return targetPath;
  }
}
