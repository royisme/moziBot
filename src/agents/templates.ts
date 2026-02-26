import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

let cachedDir: string | null | undefined;

function resolveModuleDir(): string {
  return path.dirname(fileURLToPath(import.meta.url));
}

function existsDir(dir: string): boolean {
  try {
    return fs.existsSync(dir);
  } catch {
    return false;
  }
}

export function resolveTemplatesDir(): string | null {
  if (cachedDir !== undefined) {
    return cachedDir;
  }

  const envDir = process.env.MOZI_TEMPLATES_DIR;
  const moduleDir = resolveModuleDir();
  const candidates = [
    envDir?.trim() || null,
    path.join(process.cwd(), "src", "agents", "templates"),
    path.join(process.cwd(), "dist", "templates"),
    path.join(process.cwd(), "templates"),
    path.join(moduleDir, "templates"),
    path.join(moduleDir, "agents", "templates"),
  ].filter((value): value is string => Boolean(value));

  for (const candidate of candidates) {
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
