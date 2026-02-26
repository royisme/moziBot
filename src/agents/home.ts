import fs from "node:fs/promises";
import path from "node:path";
import { logger } from "../logger";
import { resolveTemplatePath } from "./templates";

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

const HOME_STATE_FILENAME = "home-state.json";
const HOME_STATE_VERSION = 1;

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

type HomeState = {
  version: number;
  bootstrapSeededAt?: string;
  onboardingCompletedAt?: string;
};

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

function resolveHomeStatePath(dir: string): string {
  return path.join(dir, HOME_STATE_FILENAME);
}

function normalizeHomeState(input: unknown): HomeState {
  if (!input || typeof input !== "object") {
    return { version: HOME_STATE_VERSION };
  }
  const raw = input as Record<string, unknown>;
  return {
    version: HOME_STATE_VERSION,
    bootstrapSeededAt:
      typeof raw.bootstrapSeededAt === "string" ? raw.bootstrapSeededAt : undefined,
    onboardingCompletedAt:
      typeof raw.onboardingCompletedAt === "string" ? raw.onboardingCompletedAt : undefined,
  };
}

async function readHomeState(dir: string): Promise<HomeState> {
  const statePath = resolveHomeStatePath(dir);
  try {
    const raw = await fs.readFile(statePath, "utf-8");
    const parsed = JSON.parse(raw);
    return normalizeHomeState(parsed);
  } catch (err) {
    const anyErr = err as NodeJS.ErrnoException;
    if (anyErr.code && anyErr.code !== "ENOENT") {
      logger.warn(`Failed to read home state: ${String(err)}`);
    }
    return { version: HOME_STATE_VERSION };
  }
}

async function writeHomeState(dir: string, state: HomeState): Promise<void> {
  const statePath = resolveHomeStatePath(dir);
  const payload = `${JSON.stringify({ ...state, version: HOME_STATE_VERSION }, null, 2)}\n`;
  const tmpPath = `${statePath}.tmp-${process.pid}-${Date.now().toString(36)}`;
  await fs.mkdir(path.dirname(statePath), { recursive: true });
  try {
    await fs.writeFile(tmpPath, payload, "utf-8");
    await fs.rename(tmpPath, statePath);
  } catch (err) {
    await fs.unlink(tmpPath).catch(() => {});
    throw err;
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readTemplateContent(filename: string): Promise<string> {
  const templatePath = resolveTemplatePath(filename);
  if (!templatePath) {
    logger.warn(`Templates directory not found; using empty template for ${filename}`);
    return "";
  }
  const raw = await fs.readFile(templatePath, "utf-8");
  return stripFrontmatter(raw);
}

export async function ensureHome(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  const state = await readHomeState(dir);
  const skipBootstrap = Boolean(state.onboardingCompletedAt);
  let stateDirty = false;
  const nowIso = new Date().toISOString();

  for (const filename of Object.values(HOME_FILES)) {
    if (filename === HOME_FILES.BOOTSTRAP && skipBootstrap) {
      continue;
    }
    const filePath = path.join(dir, filename);
    try {
      await fs.access(filePath);
    } catch {
      logger.info(`Creating default home file: ${filename}`);
      const templatePath = resolveTemplatePath(filename);
      let content = "";
      try {
        if (!templatePath) {
          throw new Error("templates_not_found");
        }
        const raw = await fs.readFile(templatePath, "utf-8");
        // Strip frontmatter from templates
        content = stripFrontmatter(raw);
      } catch {
        logger.warn(`Template not found for ${filename}, creating empty file`);
      }
      await fs.writeFile(filePath, content);
      if (filename === HOME_FILES.BOOTSTRAP && !state.bootstrapSeededAt) {
        state.bootstrapSeededAt = nowIso;
        stateDirty = true;
      }
    }
  }

  if (stateDirty) {
    await writeHomeState(dir, state);
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
  const bootstrapExists = await fileExists(bootstrapPath);
  try {
    await fs.unlink(bootstrapPath);
    logger.info("Bootstrap ritual complete. Deleted BOOTSTRAP.md");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw err;
    }
  }

  const state = await readHomeState(dir);
  const nowIso = new Date().toISOString();
  let stateDirty = false;
  if (bootstrapExists && !state.bootstrapSeededAt) {
    state.bootstrapSeededAt = nowIso;
    stateDirty = true;
  }
  if (!state.onboardingCompletedAt) {
    state.onboardingCompletedAt = nowIso;
    stateDirty = true;
  }
  if (stateDirty) {
    await writeHomeState(dir, state);
  }
}

export async function autoCompleteBootstrapIfReady(dir: string): Promise<boolean> {
  const bootstrapPath = path.join(dir, HOME_FILES.BOOTSTRAP);
  const bootstrapExists = await fileExists(bootstrapPath);
  const state = await readHomeState(dir);

  if (state.onboardingCompletedAt) {
    if (bootstrapExists) {
      await completeBootstrap(dir);
    }
    return false;
  }

  if (bootstrapExists && !state.bootstrapSeededAt) {
    state.bootstrapSeededAt = new Date().toISOString();
    await writeHomeState(dir, state);
  }

  const [identityTemplate, userTemplate, soulTemplate] = await Promise.all([
    readTemplateContent(HOME_FILES.IDENTITY),
    readTemplateContent(HOME_FILES.USER),
    readTemplateContent(HOME_FILES.SOUL),
  ]);

  let identityContent = "";
  let userContent = "";
  let soulContent = "";
  try {
    [identityContent, userContent, soulContent] = await Promise.all([
      fs.readFile(path.join(dir, HOME_FILES.IDENTITY), "utf-8"),
      fs.readFile(path.join(dir, HOME_FILES.USER), "utf-8"),
      fs.readFile(path.join(dir, HOME_FILES.SOUL), "utf-8"),
    ]);
  } catch {
    return false;
  }

  const completed =
    identityContent !== identityTemplate &&
    userContent !== userTemplate &&
    soulContent !== soulTemplate;

  if (!completed) {
    return false;
  }

  await completeBootstrap(dir);
  return true;
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
