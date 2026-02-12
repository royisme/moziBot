import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CONFIG_REDACTION_SENTINEL,
  applyConfigOps,
  patchConfig,
  readConfigSnapshot,
  setConfigValue,
  writeConfigRawAtomic,
} from "./index";

const tempDirs: string[] = [];

function createConfigPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mozi-lifecycle-"));
  tempDirs.push(dir);
  return path.join(dir, "config.jsonc");
}

function writeBaseConfig(configPath: string): void {
  const base = {
    models: {
      providers: {
        quotio: {
          api: "openai-responses",
          apiKey: "test-key",
          models: [{ id: "gemini-3-flash-preview" }],
        },
      },
    },
    agents: {
      defaults: { model: "quotio/gemini-3-flash-preview" },
      mozi: { main: true, sandbox: { mode: "off" } },
    },
  };
  fs.writeFileSync(configPath, JSON.stringify(base, null, 2), "utf-8");
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("config lifecycle", () => {
  it("writes atomically and creates backups with retention", async () => {
    const configPath = createConfigPath();
    writeBaseConfig(configPath);

    for (let i = 0; i < 8; i += 1) {
      await setConfigValue({
        path: "logging.level",
        value: i % 2 === 0 ? "info" : "warn",
        options: { configPath },
      });
    }

    const dir = path.dirname(configPath);
    const base = path.basename(configPath);
    const backupCount = fs
      .readdirSync(dir)
      .filter((name) => name.startsWith(`${base}.bak.`)).length;
    expect(backupCount).toBeLessThanOrEqual(5);
  });

  it("fails with conflict when expected hash is stale", async () => {
    const configPath = createConfigPath();
    writeBaseConfig(configPath);

    const before = readConfigSnapshot(configPath);
    await setConfigValue({
      path: "logging.level",
      value: "debug",
      options: { configPath },
    });

    await expect(
      setConfigValue({
        path: "logging.level",
        value: "error",
        options: { configPath, expectedRawHash: before.rawHash },
      }),
    ).rejects.toThrow("Config changed since last read");
  });

  it("preserves file when patch validation fails", async () => {
    const configPath = createConfigPath();
    writeBaseConfig(configPath);
    const beforeRaw = fs.readFileSync(configPath, "utf-8");

    await expect(
      patchConfig({
        patch: {
          logging: {
            level: "not-a-valid-level",
          },
        },
        options: { configPath },
      }),
    ).rejects.toThrow("Config validation failed");

    const afterRaw = fs.readFileSync(configPath, "utf-8");
    expect(afterRaw).toBe(beforeRaw);
  });

  it("applies ordered ops transactionally", async () => {
    const configPath = createConfigPath();
    writeBaseConfig(configPath);

    const result = await applyConfigOps({
      operations: [
        { op: "set", path: "channels.telegram.enabled", value: false },
        { op: "patch", value: { logging: { level: "warn" } } },
        { op: "delete", path: "channels.telegram.enabled" },
      ],
      options: { configPath },
    });

    expect(result.after.load.success).toBe(true);
    const raw = fs.readFileSync(configPath, "utf-8");
    const parsed = JSON.parse(raw) as {
      logging?: { level?: string };
      channels?: { telegram?: { enabled?: boolean } };
    };
    expect(parsed.logging?.level).toBe("warn");
    expect(parsed.channels?.telegram?.enabled).toBeUndefined();
  });

  it("supports redaction sentinel as keep-existing for sensitive fields", async () => {
    const configPath = createConfigPath();
    writeBaseConfig(configPath);

    await patchConfig({
      patch: {
        models: {
          providers: {
            quotio: {
              apiKey: CONFIG_REDACTION_SENTINEL,
            },
          },
        },
      },
      options: { configPath },
    });

    const raw = fs.readFileSync(configPath, "utf-8");
    const parsed = JSON.parse(raw) as {
      models?: { providers?: { quotio?: { apiKey?: string } } };
    };
    expect(parsed.models?.providers?.quotio?.apiKey).toBe("test-key");
  });

  it("rejects redaction sentinel when sensitive field is missing", async () => {
    const configPath = createConfigPath();
    writeBaseConfig(configPath);

    await expect(
      patchConfig({
        patch: {
          channels: {
            telegram: {
              botToken: CONFIG_REDACTION_SENTINEL,
            },
          },
        },
        options: { configPath },
      }),
    ).rejects.toThrow("Cannot apply redaction sentinel to missing sensitive field");
  });

  it("enforces expected hash in low-level atomic writer", async () => {
    const configPath = createConfigPath();
    writeBaseConfig(configPath);

    const snapshot = readConfigSnapshot(configPath);
    await writeConfigRawAtomic(configPath, `${snapshot.raw ?? "{}"}\n`, {
      expectedRawHash: snapshot.rawHash,
    });

    await expect(
      writeConfigRawAtomic(configPath, "{}\n", {
        expectedRawHash: snapshot.rawHash,
      }),
    ).rejects.toThrow("Config changed since last read");
  });
});
