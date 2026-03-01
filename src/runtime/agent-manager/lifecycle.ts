import os from "node:os";
import path from "node:path";
import { SkillLoader } from "../../agents/skills/loader";
import type { MoziConfig } from "../../config";
import { type ExtensionRegistry, initExtensionsAsync, loadExtensions } from "../../extensions";

type SkillLoaderContext = {
  workspaceDir?: string;
};

function dedupeDirs(dirs: Array<string | undefined>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const dir of dirs) {
    if (!dir) {
      continue;
    }
    if (seen.has(dir)) {
      continue;
    }
    seen.add(dir);
    result.push(dir);
  }
  return result;
}

function resolveSkillDirs(
  config: MoziConfig,
  extensionRegistry: ExtensionRegistry,
  context?: SkillLoaderContext,
): { dirs: string[]; bundledDir: string } {
  const bundledDir = path.join(import.meta.dirname, "..", "..", "agents", "skills", "bundled");
  const baseDir = config.paths?.baseDir || path.join(os.homedir(), ".mozi");
  const managedDir =
    config.skills?.installDir ?? config.paths?.skills ?? path.join(baseDir, "skills");
  const extraDirs = config.skills?.dirs || [];
  const extSkillDirs = extensionRegistry.collectSkillDirs();
  const personalAgentsSkillsDir = path.join(os.homedir(), ".agents", "skills");
  const projectAgentsSkillsDir = context?.workspaceDir
    ? path.join(context.workspaceDir, ".agents", "skills")
    : undefined;
  const workspaceSkillsDir = context?.workspaceDir
    ? path.join(context.workspaceDir, "skills")
    : undefined;

  const dirs = dedupeDirs([
    ...extraDirs,
    ...extSkillDirs,
    bundledDir,
    managedDir,
    personalAgentsSkillsDir,
    projectAgentsSkillsDir,
    workspaceSkillsDir,
  ]);

  return { dirs, bundledDir };
}

export function createExtensionRegistry(config: MoziConfig): ExtensionRegistry {
  return loadExtensions(config.extensions);
}

export function createSkillLoader(
  config: MoziConfig,
  extensionRegistry: ExtensionRegistry,
): SkillLoader {
  const { dirs, bundledDir } = resolveSkillDirs(config, extensionRegistry);
  return new SkillLoader(dirs, {
    bundledDirs: [bundledDir],
    allowBundled: config.skills?.allowBundled,
  });
}

export function createSkillLoaderForContext(
  config: MoziConfig,
  extensionRegistry: ExtensionRegistry,
  context?: SkillLoaderContext,
): SkillLoader {
  const { dirs, bundledDir } = resolveSkillDirs(config, extensionRegistry, context);
  return new SkillLoader(dirs, {
    bundledDirs: [bundledDir],
    allowBundled: config.skills?.allowBundled,
  });
}

export async function initExtensions(
  config: MoziConfig,
  extensionRegistry: ExtensionRegistry,
): Promise<void> {
  await initExtensionsAsync(config.extensions, extensionRegistry);
}

export async function shutdownExtensions(extensionRegistry: ExtensionRegistry): Promise<void> {
  await extensionRegistry.shutdown();
}

export async function rebuildLifecycle(params: {
  previousRegistry: ExtensionRegistry;
  config: MoziConfig;
}): Promise<{ extensionRegistry: ExtensionRegistry; skillLoader: SkillLoader }> {
  const previousEnabledExtensionIds = params.previousRegistry
    .listEnabled()
    .map((ext) => ext.manifest.id);
  await shutdownExtensions(params.previousRegistry);
  const extensionRegistry = createExtensionRegistry(params.config);
  await initExtensions(params.config, extensionRegistry);
  await extensionRegistry.notifyReload(previousEnabledExtensionIds);
  const skillLoader = createSkillLoader(params.config, extensionRegistry);
  return { extensionRegistry, skillLoader };
}
