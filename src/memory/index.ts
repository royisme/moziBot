import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ensureHome } from "../agents/home";
import type { MoziConfig } from "../config";
import type { MemorySearchManager } from "./types";
import { logger } from "../logger";
import { resolveMemoryBackendConfig, resolveHomeDir } from "./backend-config";
import { BuiltinMemoryManager } from "./builtin-manager";
import { FallbackMemoryManager } from "./fallback-manager";
import { MemoryLifecycleOrchestrator } from "./lifecycle-orchestrator";
import { QmdMemoryManager } from "./qmd-manager";

const managerCache = new Map<string, MemorySearchManager>();
const lifecycleCache = new Map<string, MemoryLifecycleOrchestrator>();

export async function getMemoryManager(
  config: MoziConfig,
  agentId: string,
): Promise<MemorySearchManager> {
  const cacheKey = agentId;
  const cached = managerCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const homeDir = resolveHomeDir(config, agentId);
  await ensureHome(homeDir);
  const baseDir = config.paths?.baseDir ?? path.join(os.homedir(), ".mozi");
  const dbPath = path.join(baseDir, "memory", `${agentId}.sqlite`);
  await fs.mkdir(path.dirname(dbPath), { recursive: true });

  const resolved = resolveMemoryBackendConfig({ cfg: config, agentId });

  if (resolved.backend === "qmd" && resolved.qmd) {
    try {
      const qmdManager = await QmdMemoryManager.create({
        config,
        agentId,
        resolved,
      });
      if (qmdManager) {
        const fallbackFactory = async (): Promise<MemorySearchManager | null> => {
          return new BuiltinMemoryManager({
            workspaceDir: homeDir,
            dbPath,
            config: resolved.builtin,
          });
        };
        const manager = new FallbackMemoryManager({ primary: qmdManager, fallbackFactory }, () => {
          managerCache.delete(cacheKey);
        });
        managerCache.set(cacheKey, manager);
        return manager;
      }
    } catch (err) {
      logger.warn(`Failed to create QMD manager: ${String(err)}; using builtin`);
    }
  }

  const builtinManager = new BuiltinMemoryManager({
    workspaceDir: homeDir,
    dbPath,
    config: resolved.builtin,
  });
  managerCache.set(cacheKey, builtinManager);
  return builtinManager;
}

export async function getMemoryLifecycleOrchestrator(
  config: MoziConfig,
  agentId: string,
): Promise<MemoryLifecycleOrchestrator> {
  const cacheKey = agentId;
  const cached = lifecycleCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const manager = await getMemoryManager(config, agentId);
  const resolved = resolveMemoryBackendConfig({ cfg: config, agentId });
  const orchestrator = new MemoryLifecycleOrchestrator(manager, resolved.builtin);
  lifecycleCache.set(cacheKey, orchestrator);
  return orchestrator;
}

export function clearMemoryManagerCache(): void {
  for (const manager of managerCache.values()) {
    try {
      void manager.close?.();
    } catch {
      // ignore
    }
  }
  managerCache.clear();
  lifecycleCache.clear();
}
