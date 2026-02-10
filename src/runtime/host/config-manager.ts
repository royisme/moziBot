import { EventEmitter } from "node:events";
import { existsSync, type FSWatcher, watch } from "node:fs";
import { loadConfig, resolveConfigPath, type MoziConfig } from "../../config";
import { logger } from "../../logger";

export class ConfigManager extends EventEmitter {
  private config: MoziConfig;
  private watcher: FSWatcher | null = null;
  private readonly configPath: string;
  private debounceTimer: NodeJS.Timeout | null = null;

  constructor(configPath?: string) {
    super();
    this.configPath = resolveConfigPath(configPath);
    this.config = this.loadSync();
  }

  private loadSync(): MoziConfig {
    const result = loadConfig(this.configPath);
    if (!result.success || !result.config) {
      const message = result.errors?.join("; ") || "Unknown config error";
      throw new Error(message);
    }
    return result.config;
  }

  async load(): Promise<MoziConfig> {
    this.config = this.loadSync();
    return this.config;
  }

  async reload(): Promise<void> {
    try {
      const next = this.loadSync();
      this.config = next;
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

    this.watcher = watch(this.configPath, (event) => {
      if (event === "change") {
        if (this.debounceTimer) {
          clearTimeout(this.debounceTimer);
        }
        this.debounceTimer = setTimeout(() => this.reload(), 100);
      }
    });
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
  }
}
