import fs from "node:fs/promises";
import { join } from "node:path";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import type { SkillLoader } from "../agents/skills/loader";

function isSkillsNoteArgs(value: unknown): value is { skill: string; note: string } {
  return (
    !!value &&
    typeof value === "object" &&
    typeof (value as { skill?: unknown }).skill === "string" &&
    typeof (value as { note?: unknown }).note === "string"
  );
}

export function createSkillsNoteTool(params: {
  homeDir: string;
  skillLoader?: SkillLoader;
}): AgentTool {
  return {
    name: "skills_note",
    label: "Skills Note",
    description: "Record learnings and usage notes for a skill",
    parameters: Type.Object({
      skill: Type.String({ minLength: 1 }),
      note: Type.String({ minLength: 1 }),
    }),
    execute: async (_toolCallId, args) => {
      if (!isSkillsNoteArgs(args)) {
        throw new Error("Invalid skills_note arguments");
      }
      const skillsDir = join(params.homeDir, "skills");
      await fs.mkdir(skillsDir, { recursive: true });
      const filePath = join(skillsDir, `${args.skill}.md`);
      const now = new Date().toISOString();

      let existing = "";
      try {
        existing = await fs.readFile(filePath, "utf-8");
      } catch {
        existing = `# Skill: ${args.skill}\n\n`;
      }

      const entry = `## ${now}\n\n${args.note.trim()}\n\n`;
      const next = existing.trimEnd() + "\n\n" + entry;
      await fs.writeFile(filePath, next, "utf-8");

      if (params.skillLoader) {
        await params.skillLoader.recordUsage(params.homeDir, args.skill);
        await params.skillLoader.syncHomeIndex(params.homeDir);
      }

      return {
        content: [{ type: "text", text: `Recorded note for skill: ${args.skill}` }],
        details: {},
      };
    },
  };
}
