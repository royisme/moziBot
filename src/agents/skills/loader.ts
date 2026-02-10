import {
  loadSkillsFromDir,
  formatSkillsForPrompt,
  type Skill,
} from "@mariozechner/pi-coding-agent";
import fs from "node:fs/promises";
import { resolve, join } from "node:path";
import { logger } from "../../logger";

type SkillLoaderOptions = {
  bundledDirs?: string[];
  allowBundled?: string[];
};

export class SkillLoader {
  private skills: Skill[] = [];
  private skillsByName = new Map<string, Skill>();
  private loaded = false;
  private bundledDirSet: Set<string>;
  private allowBundledSet: Set<string>;

  constructor(
    private skillsDirs: string[],
    options?: SkillLoaderOptions,
  ) {
    this.bundledDirSet = new Set(
      (options?.bundledDirs ?? []).map((dir) => resolve(dir.replace(/^~/, process.env.HOME || ""))),
    );
    this.allowBundledSet = new Set((options?.allowBundled ?? []).map((name) => name.trim()));
  }

  // Load skills from all configured directories
  async loadAll(options?: { force?: boolean }): Promise<void> {
    if (this.loaded && options?.force !== true) {
      return;
    }

    const allSkills: Skill[] = [];

    for (const dir of this.skillsDirs) {
      const resolved = resolve(dir.replace(/^~/, process.env.HOME || ""));
      try {
        const loaded = loadSkillsFromDir({ dir: resolved, source: "mozi" });
        let skills = Array.isArray(loaded)
          ? loaded
          : ((loaded as { skills?: Skill[] })?.skills ?? []);
        if (this.bundledDirSet.has(resolved) && this.allowBundledSet.size > 0) {
          skills = skills.filter((skill) => this.allowBundledSet.has(skill.name));
        }
        allSkills.push(...skills);
        logger.info(`Loaded ${skills.length} skills from ${resolved}`);
      } catch (error) {
        logger.warn(`Failed to load skills from ${resolved}: ${error}`);
      }
    }

    // Dedupe by name (later dirs override earlier)
    this.skillsByName.clear();
    for (const skill of allSkills) {
      this.skillsByName.set(skill.name, skill);
    }
    this.skills = Array.from(this.skillsByName.values());
    this.loaded = true;
  }

  // Get a skill by name
  get(name: string): Skill | undefined {
    return this.skillsByName.get(name);
  }

  // List all loaded skills
  list(): Skill[] {
    return this.skills;
  }

  // Filter skills by names
  filter(names: string[]): Skill[] {
    return names
      .map((name) => this.skillsByName.get(name))
      .filter((skill): skill is Skill => !!skill);
  }

  // Format skills for system prompt (using pi-coding-agent)
  formatForPrompt(skillNames?: string[]): string {
    const skills = skillNames ? this.filter(skillNames) : this.skills;
    if (skills.length === 0) {
      return "";
    }
    return formatSkillsForPrompt(skills);
  }

  async syncHomeIndex(homeDir: string): Promise<void> {
    const skillsDir = join(homeDir, "skills");
    await fs.mkdir(skillsDir, { recursive: true });
    const usage = await this.readUsage(skillsDir);
    const indexPath = join(skillsDir, "INDEX.md");
    const lines: string[] = [
      "# Skills Index",
      "",
      "This file is generated from configured skill directories.",
      "",
      "## Available Skills",
      "",
    ];

    if (this.skills.length === 0) {
      lines.push("(no skills discovered)");
    } else {
      for (const skill of this.skills) {
        const description = skill.description?.trim() || "";
        const entry = description ? `${skill.name} — ${description}` : skill.name;
        lines.push(`- ${entry}`);
        const stats = usage[skill.name];
        if (stats) {
          lines.push(`Usage: ${stats.count ?? 0} (last: ${stats.lastUsed ?? "n/a"})`);
        }
        lines.push(`Location: ${skill.filePath}`);
        lines.push("");
      }
    }

    await fs.writeFile(indexPath, lines.join("\n"), "utf-8");
  }

  async recordUsage(homeDir: string, skillName: string): Promise<void> {
    const skillsDir = join(homeDir, "skills");
    await fs.mkdir(skillsDir, { recursive: true });
    const usage = await this.readUsage(skillsDir);
    const now = new Date().toISOString();
    const current = usage[skillName] || { count: 0, lastUsed: "" };
    usage[skillName] = {
      count: (current.count ?? 0) + 1,
      lastUsed: now,
    };
    await this.writeUsage(skillsDir, usage);
  }

  private async readUsage(
    skillsDir: string,
  ): Promise<Record<string, { count?: number; lastUsed?: string }>> {
    const usagePath = join(skillsDir, "usage.json");
    try {
      const raw = await fs.readFile(usagePath, "utf-8");
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, { count?: number; lastUsed?: string }>;
      }
      return {};
    } catch {
      return {};
    }
  }

  private async writeUsage(
    skillsDir: string,
    usage: Record<string, { count?: number; lastUsed?: string }>,
  ): Promise<void> {
    const usagePath = join(skillsDir, "usage.json");
    await fs.writeFile(usagePath, JSON.stringify(usage, null, 2), "utf-8");
  }
}

// Re-export types
export type { Skill };
