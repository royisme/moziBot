import type { ResolvedQmdConfig } from "../backend-config";
import type { MemorySource } from "../types";
import type { CollectionRoot } from "./path-utils";
import { logger } from "../../logger";
import { parseCollectionList, runQmd } from "./qmd-client";

export function buildCollectionIndex(collections: ResolvedQmdConfig["collections"]): {
  collectionRoots: Map<string, CollectionRoot>;
  sources: Set<MemorySource>;
} {
  const collectionRoots = new Map<string, CollectionRoot>();
  const sources = new Set<MemorySource>();
  for (const collection of collections) {
    const kind: MemorySource = collection.kind === "sessions" ? "sessions" : "memory";
    collectionRoots.set(collection.name, { path: collection.path, kind });
    sources.add(kind);
  }
  return { collectionRoots, sources };
}

export async function ensureCollections(params: {
  qmd: ResolvedQmdConfig;
  env: NodeJS.ProcessEnv;
  workspaceDir: string;
}): Promise<void> {
  const existing = new Set<string>();
  try {
    const result = await runQmd({
      command: params.qmd.command,
      args: ["collection", "list", "--json"],
      env: params.env,
      cwd: params.workspaceDir,
    });
    const parsed = parseCollectionList(result.stdout);
    for (const entry of parsed) {
      existing.add(entry);
    }
  } catch {
    // ignore unsupported list --json
  }

  for (const collection of params.qmd.collections) {
    if (existing.has(collection.name)) {
      continue;
    }
    try {
      await runQmd({
        command: params.qmd.command,
        args: [
          "collection",
          "add",
          collection.path,
          "--name",
          collection.name,
          "--mask",
          collection.pattern,
        ],
        env: params.env,
        cwd: params.workspaceDir,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.toLowerCase().includes("already exists")) {
        continue;
      }
      if (message.toLowerCase().includes("exists")) {
        continue;
      }
      logger.warn(`qmd collection add failed for ${collection.name}: ${message}`);
    }
  }
}
