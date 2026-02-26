import type { Skill } from "@mariozechner/pi-coding-agent";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { MoziConfig } from "../../config";
import { buildSkillStatusEntries } from "./status";

const SKILL_ALPHA = (platform: string) => `---
name: alpha
description: Alpha
metadata:
  mozi:
    os:
      - ${platform}
    requires:
      bins:
        - mozi-fake-bin
      anyBins:
        - mozi-any-a
        - mozi-any-b
      env:
        - MOZI_TEST_ENV
      config:
        - runtime.fakeFlag
    install:
      - kind: brew
        formula: alpha
      - kind: node
        package: alpha-cli
---
# Alpha
`;

const SKILL_BETA = `---
name: beta
description: Beta
metadata:
  mozi:
    always: true
    requires:
      env:
        - SHOULD_NOT_MATTER
---
# Beta
`;

describe("buildSkillStatusEntries", () => {
  let tempDir: string;
  let skillsDir: string;
  let prevEnv: string | undefined;

  beforeEach(async () => {
    prevEnv = process.env.MOZI_TEST_ENV;
    delete process.env.MOZI_TEST_ENV;
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "mozi-skill-status-"));
    skillsDir = path.join(tempDir, "skills");
    await fs.mkdir(path.join(skillsDir, "alpha"), { recursive: true });
    await fs.mkdir(path.join(skillsDir, "beta"), { recursive: true });
    await fs.writeFile(path.join(skillsDir, "alpha", "SKILL.md"), SKILL_ALPHA(process.platform));
    await fs.writeFile(path.join(skillsDir, "beta", "SKILL.md"), SKILL_BETA);
  });

  afterEach(async () => {
    if (prevEnv !== undefined) {
      process.env.MOZI_TEST_ENV = prevEnv;
    } else {
      delete process.env.MOZI_TEST_ENV;
    }
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("computes missing requirements and install hints", async () => {
    const skills: Skill[] = [
      {
        name: "alpha",
        description: "Alpha",
        filePath: path.join(skillsDir, "alpha", "SKILL.md"),
        baseDir: skillsDir,
        source: "test",
        disableModelInvocation: false,
      },
      {
        name: "beta",
        description: "Beta",
        filePath: path.join(skillsDir, "beta", "SKILL.md"),
        baseDir: skillsDir,
        source: "test",
        disableModelInvocation: false,
      },
    ];

    const config = {
      skills: {
        install: {
          nodeManager: "pnpm",
        },
      },
    } as MoziConfig;

    const entries = await buildSkillStatusEntries({ skills, config });
    const alpha = entries.find((entry) => entry.name === "alpha");
    const beta = entries.find((entry) => entry.name === "beta");

    expect(alpha).toBeDefined();
    expect(alpha?.eligible).toBe(false);
    expect(alpha?.missing.bins).toEqual(["mozi-fake-bin"]);
    expect(alpha?.missing.anyBins).toEqual(["mozi-any-a", "mozi-any-b"]);
    expect(alpha?.missing.env).toEqual(["MOZI_TEST_ENV"]);
    expect(alpha?.missing.config).toEqual(["runtime.fakeFlag"]);
    expect(alpha?.missing.os).toEqual([]);
    expect(alpha?.install.map((option) => option.label)).toEqual([
      "Install alpha (brew)",
      "Install alpha-cli (pnpm)",
    ]);

    expect(beta).toBeDefined();
    expect(beta?.eligible).toBe(true);
    expect(beta?.missing.bins).toEqual([]);
    expect(beta?.missing.anyBins).toEqual([]);
    expect(beta?.missing.env).toEqual([]);
    expect(beta?.missing.config).toEqual([]);
    expect(beta?.missing.os).toEqual([]);
  });
});
