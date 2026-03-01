import fs from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

function resolveUserPath(filePath: string): string | null {
  const trimmed = filePath.trim();
  if (!trimmed) {
    return null;
  }
  // Resolve ~ to home directory
  if (trimmed.startsWith("~/") || trimmed === "~") {
    return path.resolve(homedir(), trimmed.slice(1));
  }
  return path.resolve(trimmed);
}

export function readSecretFromFile(filePath: string, label: string): string {
  const resolvedPath = resolveUserPath(filePath.trim());
  if (!resolvedPath) {
    throw new Error(`${label} file path is empty.`);
  }
  let raw = "";
  try {
    raw = fs.readFileSync(resolvedPath, "utf8");
  } catch (err) {
    throw new Error(`Failed to read ${label} file at ${resolvedPath}: ${String(err)}`, {
      cause: err,
    });
  }
  const secret = raw.trim();
  if (!secret) {
    throw new Error(`${label} file at ${resolvedPath} is empty.`);
  }
  return secret;
}
