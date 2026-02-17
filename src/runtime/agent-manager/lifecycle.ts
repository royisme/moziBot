import os from "node:os";
import path from "node:path";
import type { MoziConfig } from "../../config";
import { SkillLoader } from "../../agents/skills/loader";
import { type ExtensionRegistry, initExtensionsAsync, loadExtensions } from "../../extensions";

export function createExtensionRegistry(config: MoziConfig): ExtensionRegistry {
  return loadExtensions(config.extensions);
}

export function createSkillLoader(
  config: MoziConfig,
  extensionRegistry: ExtensionRegistry,
): SkillLoader {
  const dirs: string[] = [];
  const bundledDir = path.join(import.meta.dirname, "..", "..", "agents", "skills", "bundled");
  dirs.push(bundledDir);
  const baseDir = config.paths?.baseDir || path.join(os.homedir(), ".mozi");
  dirs.push(path.join(baseDir, "skills"));
  const extraDirs = config.skills?.dirs || [];
  dirs.push(...extraDirs);
  if (config.paths?.skills) {
    dirs.push(config.paths.skills);
  }
  const extSkillDirs = extensionRegistry.collectSkillDirs();
  dirs.push(...extSkillDirs);

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
