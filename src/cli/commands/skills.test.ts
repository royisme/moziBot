import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildSkillsReport } from "./skills";

const SKILL_MD = `---
name: demo-skill
description: Demo skill
---
# Demo Skill
`;

describe("buildSkillsReport", () => {
  let tempDir: string;
  let skillsDir: string;
  let configPath: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "mozi-skills-cli-"));
    skillsDir = path.join(tempDir, "custom-skills");
    await fs.mkdir(path.join(skillsDir, "demo-skill"), { recursive: true });
    await fs.writeFile(path.join(skillsDir, "demo-skill", "SKILL.md"), SKILL_MD);

    const config = {
      paths: {
        baseDir: tempDir,
      },
      skills: {
        dirs: [skillsDir],
        allowBundled: ["__none__"],
      },
      extensions: {
        enabled: false,
      },
    };
    configPath = path.join(tempDir, "config.jsonc");
    await fs.writeFile(configPath, JSON.stringify(config, null, 2));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("returns configured dirs and discovered skills", async () => {
    const report = await buildSkillsReport({ configPath });

    expect(report.skillDirs).toContain(skillsDir);
    const names = report.skills.map((skill) => skill.name);
    expect(names).toContain("demo-skill");
  });
});
