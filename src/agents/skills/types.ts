export interface SkillManifest {
  name: string;
  description: string;
  version?: string;
  tools?: SkillTool[];
  scripts?: Record<string, string>; // name -> path
}

export interface SkillTool {
  name: string;
  description: string;
  script: string; // Path to script
}

export interface LoadedSkill {
  manifest: SkillManifest;
  path: string; // Skill directory
  skillMdContent: string; // SKILL.md content
}
