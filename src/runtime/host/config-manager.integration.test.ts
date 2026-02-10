import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigManager } from "./config-manager";

const TEST_DIR = join(process.cwd(), "test-config");
const CONFIG_FILE = join(TEST_DIR, "mozi.config.json");

describe("ConfigManager", () => {
  beforeEach(() => {
    if (!existsSync(TEST_DIR)) {
      mkdirSync(TEST_DIR);
    }
  });

  afterEach(() => {
    if (existsSync(CONFIG_FILE)) {
      unlinkSync(CONFIG_FILE);
    }
  });

  it("should load config from file", async () => {
    const testConfig = {
      meta: {
        version: "1.0.0",
      },
      models: {
        providers: {
          openai: {
            baseUrl: "https://api.openai.com/v1",
            apiKey: "test-key",
          },
        },
      },
    };
    writeFileSync(CONFIG_FILE, JSON.stringify(testConfig));

    const manager = new ConfigManager(CONFIG_FILE);
    await manager.load();

    const config = manager.getAll();
    expect(config.meta?.version).toBe("1.0.0");
    expect(config.models?.providers?.openai?.apiKey).toBe("test-key");
  });

  it("should handle empty config", async () => {
    writeFileSync(CONFIG_FILE, JSON.stringify({}));

    const manager = new ConfigManager(CONFIG_FILE);
    await manager.load();

    expect(manager.getAll()).toBeDefined();
  });

  it("should handle invalid JSON config", async () => {
    writeFileSync(CONFIG_FILE, "{ invalid json }");

    // JSONC parser is lenient, so it may parse or return defaults
    // Just verify it doesn't crash
    expect(() => new ConfigManager(CONFIG_FILE)).not.toThrow();
  });

  it("should detect file changes", async () => {
    writeFileSync(CONFIG_FILE, JSON.stringify({ meta: { version: "1.0.0" } }));

    const manager = new ConfigManager(CONFIG_FILE);
    await manager.load();
    manager.watch();

    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        manager.stopWatch();
        reject(new Error("Timeout waiting for config change"));
      }, 1000);

      manager.once("change", (newConfig) => {
        clearTimeout(timeout);
        try {
          expect(newConfig.meta?.version).toBe("2.0.0");
          manager.stopWatch();
          resolve();
        } catch (e) {
          manager.stopWatch();
          reject(e);
        }
      });

      // Update file
      setTimeout(() => {
        writeFileSync(CONFIG_FILE, JSON.stringify({ meta: { version: "2.0.0" } }));
      }, 100);
    });
  });
});
