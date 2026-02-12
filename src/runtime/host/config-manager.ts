import { EventEmitter } from "node:events";
import { existsSync, type FSWatcher, watch } from "node:fs";
import { readConfigSnapshot, resolveConfigPath, type MoziConfig } from "../../config";
import { logger } from "../../logger";

export class ConfigManager extends EventEmitter {
  private config: MoziConfig;
  private watcher: FSWatcher | null = null;
  private readonly configPath: string;
  private debounceTimer: NodeJS.Timeout | null = null;
  private watcherRearmTimer: NodeJS.Timeout | null = null;
  private lastRawHash: string | null = null;

  constructor(configPath?: string) {
    super();
    this.configPath = resolveConfigPath(configPath);
    this.config = {};
  }

  private loadSync(): { config: MoziConfig; rawHash: string } {
    const snapshot = readConfigSnapshot(this.configPath);
    if (!snapshot.load.success || !snapshot.load.config) {
      const message = snapshot.load.errors?.join("; ") || "Unknown config error";
      throw new Error(message);
    }
    return {
      config: snapshot.load.config,
      rawHash: snapshot.rawHash,
    };
  }

  async load(): Promise<MoziConfig> {
    const loaded = this.loadSync();
    this.config = loaded.config;
    this.lastRawHash = loaded.rawHash;
    return this.config;
  }

  async reload(): Promise<void> {
    try {
      const next = this.loadSync();
      if (this.lastRawHash === next.rawHash) {
        return;
      }
      this.config = next.config;
      this.lastRawHash = next.rawHash;
      this.emit("change", this.config);
      logger.info("Configuration reloaded");
    } catch (error) {
      logger.error(
        `Failed to reload configuration: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  getAll(): MoziConfig {
    return this.config;
  }

  watch(): void {
    if (this.watcher) {
      return;
    }

    if (!existsSync(this.configPath)) {
      logger.warn(`Config file not found at ${this.configPath}, hot reload disabled.`);
      return;
    }

    this.startWatcher();
  }

  private startWatcher(): void {
    this.watcher = watch(this.configPath, (event) => {
      if (event === "change" || event === "rename") {
        this.scheduleReload();
      }
      if (event === "rename") {
        this.rearmWatcher();
      }
    });
  }

  private scheduleReload(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => this.reload(), 100);
  }

  private rearmWatcher(): void {
    if (this.watcherRearmTimer) {
      clearTimeout(this.watcherRearmTimer);
    }
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    this.watcherRearmTimer = setTimeout(() => {
      this.watcherRearmTimer = null;
      if (!existsSync(this.configPath) || this.watcher) {
        return;
      }
      this.startWatcher();
    }, 120);
  }

  stopWatch(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.watcherRearmTimer) {
      clearTimeout(this.watcherRearmTimer);
      this.watcherRearmTimer = null;
    }
  }
}
