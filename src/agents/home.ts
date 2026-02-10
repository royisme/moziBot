import fs from "node:fs/promises";
import path from "node:path";
import { logger } from "../logger";

/**
 * Home = Agent's identity directory
 * Contains: AGENTS.md, SOUL.md, IDENTITY.md, USER.md, MEMORY.md, BOOTSTRAP.md, HEARTBEAT.md
 * Path: ~/.mozi/agents/<agent-id>/
 */

export const HOME_FILES = {
  AGENTS: "AGENTS.md",
  SOUL: "SOUL.md",
  IDENTITY: "IDENTITY.md",
  USER: "USER.md",
  MEMORY: "MEMORY.md",
  BOOTSTRAP: "BOOTSTRAP.md",
  HEARTBEAT: "HEARTBEAT.md",
} as const;

// Files to load into context (exclude BOOTSTRAP - handled separately)
export const HOME_CONTEXT_FILES = [
  "AGENTS.md",
  "SOUL.md",
  "IDENTITY.md",
  "USER.md",
  "MEMORY.md",
  "HEARTBEAT.md",
] as const;

export interface HomeFile {
  name: string;
  path: string;
  content: string;
  missing: boolean;
}

export interface BootstrapState {
  isBootstrapping: boolean;
  bootstrapPath: string;
  bootstrapContent?: string;
}

/**
 * Strip YAML frontmatter from markdown content
 */
function stripFrontmatter(content: string): string {
  if (!content.startsWith("---")) {
    return content;
  }
  const endIndex = content.indexOf("\n---", 3);
  if (endIndex === -1) {
    return content;
  }
  return content.slice(endIndex + 4).replace(/^\s+/, "");
}

export async function ensureHome(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });

  for (const filename of Object.values(HOME_FILES)) {
    const filePath = path.join(dir, filename);
    try {
      await fs.access(filePath);
    } catch {
      logger.info(`Creating default home file: ${filename}`);
      const templatePath = path.join(__dirname, "templates", filename);
      let content = "";
      try {
        const raw = await fs.readFile(templatePath, "utf-8");
        // Strip frontmatter from templates
        content = stripFrontmatter(raw);
      } catch {
        logger.warn(`Template not found for ${filename}, creating empty file`);
      }
      await fs.writeFile(filePath, content);
    }
  }
}

/**
 * Check if BOOTSTRAP.md exists (indicates first-run ritual needed)
 */
export async function checkBootstrapState(dir: string): Promise<BootstrapState> {
  const bootstrapPath = path.join(dir, HOME_FILES.BOOTSTRAP);
  try {
    const rawContent = await fs.readFile(bootstrapPath, "utf-8");
    const content = stripFrontmatter(rawContent);
    return {
      isBootstrapping: true,
      bootstrapPath,
      bootstrapContent: content,
    };
  } catch {
    return {
      isBootstrapping: false,
      bootstrapPath,
    };
  }
}

/**
 * Complete the bootstrap ritual by deleting BOOTSTRAP.md
 */
export async function completeBootstrap(dir: string): Promise<void> {
  const bootstrapPath = path.join(dir, HOME_FILES.BOOTSTRAP);
  try {
    await fs.unlink(bootstrapPath);
    logger.info("Bootstrap ritual complete. Deleted BOOTSTRAP.md");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw err;
    }
  }
}

/**
 * Update a home file (used during bootstrap to save identity/user info)
 */
export async function updateHomeFile(
  dir: string,
  filename: string,
  content: string,
): Promise<void> {
  const filePath = path.join(dir, filename);
  await fs.writeFile(filePath, content, "utf-8");
  logger.info(`Updated home file: ${filename}`);
}

export async function loadHomeFiles(dir: string): Promise<HomeFile[]> {
  const files: HomeFile[] = [];

  // Load context files (not BOOTSTRAP)
  for (const filename of HOME_CONTEXT_FILES) {
    const filePath = path.join(dir, filename);
    try {
      const content = await fs.readFile(filePath, "utf-8");
      files.push({
        name: filename,
        path: filePath,
        content,
        missing: false,
      });
    } catch {
      files.push({
        name: filename,
        path: filePath,
        content: "",
        missing: true,
      });
    }
  }

  return files;
}

export function buildContextFromFiles(files: HomeFile[]): string {
  return files
    .filter((f) => !f.missing && f.content.trim() !== "")
    .map((f) => `## ${f.name}\n\n${f.content}`)
    .join("\n\n");
}

/**
 * Build context with bootstrap instructions if in bootstrap mode
 */
export function buildContextWithBootstrap(
  files: HomeFile[],
  bootstrapState: BootstrapState,
): string {
  const baseContext = buildContextFromFiles(files);

  if (!bootstrapState.isBootstrapping || !bootstrapState.bootstrapContent) {
    return baseContext;
  }

  // Prepend bootstrap instructions
  const bootstrapSection = `## 🎭 BOOTSTRAP MODE (First Run)

${bootstrapState.bootstrapContent}

---
**IMPORTANT**: After completing the bootstrap ritual:
1. Update IDENTITY.md with the agent's chosen name, creature type, vibe, and emoji
2. Update USER.md with the user's name, timezone, and preferences
3. Update SOUL.md with any personalization discussed
4. Call the \`complete_bootstrap\` tool to finish setup

---

`;

  return bootstrapSection + baseContext;
}
