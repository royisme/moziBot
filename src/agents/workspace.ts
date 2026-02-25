import fs from "node:fs/promises";
import path from "node:path";
import { logger } from "../logger";

/**
 * Workspace = User's working directory
 * Contains: Work artifacts (code, docs, etc.) + WORK.md + optional TOOLS.md
 * Path: User-specified, e.g. ~/workspace/ or ~/projects/
 */

export const WORKSPACE_FILES = {
  WORK: "WORK.md", // Project rules (optional)
  TOOLS: "TOOLS.md", // User's tool notes (optional)
} as const;

export interface WorkspaceFile {
  name: string;
  path: string;
  content: string;
  missing: boolean;
}

export async function ensureWorkspace(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });

  // Only create WORK.md if it doesn't exist
  const workPath = path.join(dir, WORKSPACE_FILES.WORK);
  try {
    await fs.access(workPath);
  } catch {
    logger.info("Creating default WORK.md in workspace");
    const templatePath = path.join(__dirname, "templates", "WORK.md");
    let content = "# WORK.md\n\nDocument your project rules here.\n";
    try {
      const raw = await fs.readFile(templatePath, "utf-8");
      // Strip frontmatter
      content = raw.replace(/^---[\s\S]*?---\s*/, "");
    } catch {
      // Use default content
    }
    await fs.writeFile(workPath, content);
  }

  // Only create TOOLS.md if it doesn't exist
  const toolsPath = path.join(dir, WORKSPACE_FILES.TOOLS);
  try {
    await fs.access(toolsPath);
  } catch {
    logger.info("Creating default TOOLS.md in workspace");
    const templatePath = path.join(__dirname, "templates", "TOOLS.md");
    let content = "# TOOLS.md\n\nDocument your tools and scripts here.\n";
    try {
      const raw = await fs.readFile(templatePath, "utf-8");
      // Strip frontmatter
      content = raw.replace(/^---[\s\S]*?---\s*/, "");
    } catch {
      // Use default content
    }
    await fs.writeFile(toolsPath, content);
  }
}

export async function loadWorkspaceFiles(dir: string): Promise<WorkspaceFile[]> {
  const files: WorkspaceFile[] = [];

  const workPath = path.join(dir, WORKSPACE_FILES.WORK);
  try {
    const content = await fs.readFile(workPath, "utf-8");
    files.push({
      name: WORKSPACE_FILES.WORK,
      path: workPath,
      content,
      missing: false,
    });
  } catch {
    files.push({
      name: WORKSPACE_FILES.WORK,
      path: workPath,
      content: "",
      missing: true,
    });
  }

  const toolsPath = path.join(dir, WORKSPACE_FILES.TOOLS);
  try {
    const content = await fs.readFile(toolsPath, "utf-8");
    files.push({
      name: WORKSPACE_FILES.TOOLS,
      path: toolsPath,
      content,
      missing: false,
    });
  } catch {
    files.push({
      name: WORKSPACE_FILES.TOOLS,
      path: toolsPath,
      content: "",
      missing: true,
    });
  }

  return files;
}

export function buildWorkspaceContext(files: WorkspaceFile[], workspaceDir: string): string {
  const sections: string[] = [];

  // Workspace path info
  sections.push(
    `# Workspace\nPath: ${workspaceDir}\nRule: Save work artifacts in the workspace directory.`,
  );

  // Include WORK.md if present (or missing marker)
  const workFile = files.find((f) => f.name === WORKSPACE_FILES.WORK);
  if (workFile) {
    if (workFile.missing) {
      sections.push(`## ${workFile.name}\n\n[MISSING] Expected at: ${workFile.path}`);
    } else if (workFile.content.trim()) {
      sections.push(`## ${workFile.name}\n\n${workFile.content}`);
    }
  }

  // Include TOOLS.md if present
  const toolsFile = files.find((f) => f.name === WORKSPACE_FILES.TOOLS);
  if (toolsFile) {
    if (toolsFile.missing) {
      sections.push(`## ${toolsFile.name}\n\n[MISSING] Expected at: ${toolsFile.path}`);
    } else if (toolsFile.content.trim()) {
      sections.push(`## ${toolsFile.name}\n\n${toolsFile.content}`);
    }
  }

  return sections.join("\n\n");
}
