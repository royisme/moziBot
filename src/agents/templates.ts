import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REQUIRED_TEMPLATES = [
  "AGENTS.md",
  "SOUL.md",
  "IDENTITY.md",
  "USER.md",
  "MEMORY.md",
  "BOOTSTRAP.md",
  "HEARTBEAT.md",
  "WORK.md",
  "TOOLS.md",
] as const;

const FALLBACK_TEMPLATE_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "templates",
);

let cachedDir: string | null | undefined;

function resolveModuleDir(moduleUrl: string): string {
  return path.dirname(fileURLToPath(moduleUrl));
}

function existsDir(dir: string): boolean {
  try {
    return fs.existsSync(dir) && fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

function isCompleteTemplateDir(dir: string): boolean {
  if (!existsDir(dir)) {
    return false;
  }
  return REQUIRED_TEMPLATES.every((filename) => fs.existsSync(path.join(dir, filename)));
}

function findNearestPackageRoot(startDir: string): string | null {
  let current = path.resolve(startDir);
  for (;;) {
    if (fs.existsSync(path.join(current, "package.json"))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

export function resolveTemplatesDir(opts?: {
  cwd?: string;
  argv1?: string;
  moduleUrl?: string;
}): string | null {
  if (cachedDir !== undefined) {
    return cachedDir;
  }

  const moduleUrl = opts?.moduleUrl ?? import.meta.url;
  const cwd = opts?.cwd ?? process.cwd();
  const argv1 = opts?.argv1 ?? process.argv[1];

  const envDir = process.env.MOZI_TEMPLATES_DIR?.trim();
  if (envDir && existsDir(envDir)) {
    cachedDir = envDir;
    return cachedDir;
  }

  const moduleDir = resolveModuleDir(moduleUrl);
  const packageRoots = [
    findNearestPackageRoot(moduleDir),
    argv1 ? findNearestPackageRoot(path.dirname(path.resolve(argv1))) : null,
    cwd ? findNearestPackageRoot(cwd) : null,
  ].filter((value, index, arr): value is string => Boolean(value) && arr.indexOf(value) === index);

  const completeCandidates = packageRoots
    .flatMap((root) => [
      path.join(root, "docs", "reference", "templates"),
      path.join(root, "src", "agents", "templates"),
      path.join(root, "dist", "templates"),
      path.join(root, "templates"),
    ])
    .filter((value, index, arr) => arr.indexOf(value) === index);

  for (const candidate of completeCandidates) {
    if (isCompleteTemplateDir(candidate)) {
      cachedDir = candidate;
      return cachedDir;
    }
  }

  const fallbackCandidates = [
    ...completeCandidates,
    path.join(moduleDir, "templates"),
    path.join(moduleDir, "agents", "templates"),
    FALLBACK_TEMPLATE_DIR,
  ].filter((value, index, arr) => arr.indexOf(value) === index);

  for (const candidate of fallbackCandidates) {
    if (existsDir(candidate)) {
      cachedDir = candidate;
      return cachedDir;
    }
  }

  cachedDir = null;
  return cachedDir;
}

export function resolveTemplatePath(filename: string): string | null {
  const dir = resolveTemplatesDir();
  if (!dir) {
    return null;
  }
  return path.join(dir, filename);
}

export function resetTemplatesDirCache() {
  cachedDir = undefined;
}
