import path from "node:path";
import type { MemorySource } from "../types";

export type CollectionRoot = {
  path: string;
  kind: MemorySource;
};

export function isWithinRoot(root: string, candidate: string): boolean {
  const normalizedRoot = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  if (candidate === root) {
    return true;
  }
  const next = candidate.endsWith(path.sep) ? candidate : `${candidate}${path.sep}`;
  return next.startsWith(normalizedRoot);
}

export function isInsideWorkspace(relativePath: string): boolean {
  if (!relativePath) {
    return true;
  }
  if (relativePath.startsWith("..")) {
    return false;
  }
  if (relativePath.startsWith(`..${path.sep}`)) {
    return false;
  }
  return !path.isAbsolute(relativePath);
}

export function buildSearchPath(params: {
  collection: string;
  collectionRelativePath: string;
  relativeToWorkspace: string;
  absPath: string;
}): string {
  const insideWorkspace = isInsideWorkspace(params.relativeToWorkspace);
  if (insideWorkspace) {
    const normalized = params.relativeToWorkspace.replace(/\\/g, "/");
    if (!normalized) {
      return path.basename(params.absPath);
    }
    return normalized;
  }
  const sanitized = params.collectionRelativePath.replace(/^\/+/, "");
  return `qmd/${params.collection}/${sanitized}`;
}

export function resolveReadPath(params: {
  relPath: string;
  workspaceDir: string;
  collectionRoots: Map<string, CollectionRoot>;
}): string {
  if (params.relPath.startsWith("qmd/")) {
    const [, collection, ...rest] = params.relPath.split("/");
    if (!collection || rest.length === 0) {
      throw new Error("invalid qmd path");
    }
    const root = params.collectionRoots.get(collection);
    if (!root) {
      throw new Error(`unknown qmd collection: ${collection}`);
    }
    const joined = rest.join("/");
    const resolved = path.resolve(root.path, joined);
    if (!isWithinRoot(root.path, resolved)) {
      throw new Error("path escapes collection");
    }
    return resolved;
  }
  const absPath = path.resolve(params.workspaceDir, params.relPath);
  if (!isWithinWorkspace(params.workspaceDir, absPath)) {
    throw new Error("path escapes workspace");
  }
  return absPath;
}

export function isWithinWorkspace(workspaceDir: string, absPath: string): boolean {
  const normalizedWorkspace = workspaceDir.endsWith(path.sep)
    ? workspaceDir
    : `${workspaceDir}${path.sep}`;
  if (absPath === workspaceDir) {
    return true;
  }
  const candidate = absPath.endsWith(path.sep) ? absPath : `${absPath}${path.sep}`;
  return candidate.startsWith(normalizedWorkspace);
}
