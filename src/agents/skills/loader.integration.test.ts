import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { SkillLoader } from "./loader";

describe("SkillLoader", () => {
  const testSkillsDir = join(
    process.cwd(),
    `tmp-test-skills-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  const bundledSkillsDir = join(
    process.cwd(),
    `tmp-test-bundled-skills-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );

  beforeAll(async () => {
    await mkdir(testSkillsDir, { recursive: true });
    await mkdir(bundledSkillsDir, { recursive: true });

    // Create test skills with proper frontmatter format
    const skill1Path = join(testSkillsDir, "skill1");
    await mkdir(skill1Path, { recursive: true });
    await writeFile(
      join(skill1Path, "SKILL.md"),
      `---
name: skill1
description: Skill 1 Description
---
# Skill 1
This is skill 1 content.`,
    );

    const skill2Path = join(testSkillsDir, "weather");
    await mkdir(skill2Path, { recursive: true });
    await writeFile(
      join(skill2Path, "SKILL.md"),
      `---
name: weather
description: Get weather forecasts
---
# Weather
Provides weather information.`,
    );

    const bundledWebPath = join(bundledSkillsDir, "web-search");
    await mkdir(bundledWebPath, { recursive: true });
    await writeFile(
      join(bundledWebPath, "SKILL.md"),
      `---
name: web-search
description: Bundled web search
---
# Web Search
Bundled web search skill.`,
    );

    const bundledSummarizePath = join(bundledSkillsDir, "summarize");
    await mkdir(bundledSummarizePath, { recursive: true });
    await writeFile(
      join(bundledSummarizePath, "SKILL.md"),
      `---
name: summarize
description: Bundled summarize
---
# Summarize
Bundled summarize skill.`,
    );
  });

  afterAll(async () => {
    await rm(testSkillsDir, { recursive: true, force: true });
    await rm(bundledSkillsDir, { recursive: true, force: true });
  });

  test("loadAll discovers skills from directories", async () => {
    const loader = new SkillLoader([testSkillsDir]);
    await loader.loadAll();

    const skills = loader.list();
    expect(skills.length).toBe(2);
  });

  test("get returns skill by name", async () => {
    const loader = new SkillLoader([testSkillsDir]);
    await loader.loadAll();

    const skill = loader.get("skill1");
    expect(skill).toBeDefined();
    expect(skill?.name).toBe("skill1");
  });

  test("get returns undefined for non-existent skill", async () => {
    const loader = new SkillLoader([testSkillsDir]);
    await loader.loadAll();

    expect(loader.get("non-existent")).toBeUndefined();
  });

  test("filter returns subset of skills by names", async () => {
    const loader = new SkillLoader([testSkillsDir]);
    await loader.loadAll();

    const filtered = loader.filter(["weather"]);
    expect(filtered.length).toBe(1);
    expect(filtered[0].name).toBe("weather");
  });

  test("formatForPrompt generates prompt text", async () => {
    const loader = new SkillLoader([testSkillsDir]);
    await loader.loadAll();

    const prompt = loader.formatForPrompt(["skill1"]);
    expect(prompt).toContain("skill");
  });

  test("formatForPrompt with no skills returns empty", async () => {
    const loader = new SkillLoader([testSkillsDir]);
    await loader.loadAll();

    const prompt = loader.formatForPrompt([]);
    expect(prompt).toBe("");
  });

  test("supports multiple directories", async () => {
    const secondDir = join(
      process.cwd(),
      `tmp-test-skills-2-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    await mkdir(secondDir, { recursive: true });
    const extraSkillPath = join(secondDir, "extra-skill");
    await mkdir(extraSkillPath, { recursive: true });
    await writeFile(
      join(extraSkillPath, "SKILL.md"),
      `---
name: extra-skill
description: Extra skill
---
# Extra
Extra skill content.`,
    );

    const loader = new SkillLoader([testSkillsDir, secondDir]);
    await loader.loadAll();

    const skills = loader.list();
    expect(skills.length).toBe(3);
    expect(loader.get("extra-skill")).toBeDefined();

    await rm(secondDir, { recursive: true, force: true });
  });

  test("loadAll is idempotent", async () => {
    const loader = new SkillLoader([testSkillsDir]);
    await loader.loadAll();
    const first = loader
      .list()
      .map((skill) => skill.name)
      .sort();

    await loader.loadAll();
    const second = loader
      .list()
      .map((skill) => skill.name)
      .sort();

    expect(second).toEqual(first);
  });

  test("allowBundled filters only bundled skills", async () => {
    const loader = new SkillLoader([bundledSkillsDir, testSkillsDir], {
      bundledDirs: [bundledSkillsDir],
      allowBundled: ["web-search"],
    });
    await loader.loadAll();

    const names = loader
      .list()
      .map((skill) => skill.name)
      .sort();
    expect(names).toContain("web-search");
    expect(names).not.toContain("summarize");
    expect(names).toContain("skill1");
    expect(names).toContain("weather");
  });
});
