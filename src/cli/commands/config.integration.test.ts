import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { CONFIG_REDACTION_SENTINEL } from "../../config";

const CLI_PATH = "src/cli/index.ts";

const BASE_CONFIG = {
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

test("config snapshot/set/unset/patch/apply full flow", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mozi-config-cli-"));
  const configPath = path.join(tmpDir, "config.jsonc");
  fs.writeFileSync(configPath, JSON.stringify(BASE_CONFIG, null, 2), "utf-8");

  const snapshot = spawnSync("tsx", [CLI_PATH, "config", "snapshot", "-c", configPath, "--json"], {
    env: { ...process.env, MOZI_CLI: "true" },
  });
  expect(snapshot.status).toBe(0);
  const snapshotParsed = JSON.parse(snapshot.stdout.toString()) as { rawHash: string };
  expect(snapshotParsed.rawHash).toBeTruthy();

  const set = spawnSync(
    "tsx",
    [CLI_PATH, "config", "set", "logging.level", "debug", "-c", configPath],
    { env: { ...process.env, MOZI_CLI: "true" } },
  );
  expect(set.status).toBe(0);
  expect(set.stdout.toString()).toContain("Config updated.");

  const unset = spawnSync("tsx", [CLI_PATH, "config", "unset", "logging.level", "-c", configPath], {
    env: { ...process.env, MOZI_CLI: "true" },
  });
  expect(unset.status).toBe(0);
  expect(unset.stdout.toString()).toContain("Config updated.");

  const patch = spawnSync(
    "tsx",
    [
      CLI_PATH,
      "config",
      "patch",
      '{"logging":{"level":"warn"},"channels":{"telegram":{"enabled":false}}}',
      "-c",
      configPath,
    ],
    { env: { ...process.env, MOZI_CLI: "true" } },
  );
  expect(patch.status).toBe(0);
  expect(patch.stdout.toString()).toContain("Config patched.");

  const opsPath = path.join(tmpDir, "ops.json");
  fs.writeFileSync(
    opsPath,
    JSON.stringify(
      [
        { op: "set", path: "channels.localDesktop.enabled", value: true },
        { op: "delete", path: "channels.telegram.enabled" },
      ],
      null,
      2,
    ),
    "utf-8",
  );
  const apply = spawnSync("tsx", [CLI_PATH, "config", "apply", "-f", opsPath, "-c", configPath], {
    env: { ...process.env, MOZI_CLI: "true" },
  });
  expect(apply.status).toBe(0);
  expect(apply.stdout.toString()).toContain("Config applied.");

  const finalRaw = fs.readFileSync(configPath, "utf-8");
  const finalConfig = JSON.parse(finalRaw) as {
    logging?: { level?: string };
    channels?: {
      telegram?: { enabled?: boolean };
      localDesktop?: { enabled?: boolean };
    };
  };
  expect(finalConfig.logging?.level).toBe("warn");
  expect(finalConfig.channels?.localDesktop?.enabled).toBe(true);
  expect(finalConfig.channels?.telegram?.enabled).toBeUndefined();
});

test("config set with stale if-hash fails with exit code 2", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mozi-config-conflict-"));
  const configPath = path.join(tmpDir, "config.jsonc");
  fs.writeFileSync(configPath, JSON.stringify(BASE_CONFIG, null, 2), "utf-8");

  const snapshot = spawnSync("tsx", [CLI_PATH, "config", "snapshot", "-c", configPath, "--json"], {
    env: { ...process.env, MOZI_CLI: "true" },
  });
  expect(snapshot.status).toBe(0);
  const snapshotParsed = JSON.parse(snapshot.stdout.toString()) as { rawHash: string };

  const mutate = spawnSync(
    "tsx",
    [CLI_PATH, "config", "set", "logging.level", "info", "-c", configPath],
    { env: { ...process.env, MOZI_CLI: "true" } },
  );
  expect(mutate.status).toBe(0);

  const conflict = spawnSync(
    "tsx",
    [
      CLI_PATH,
      "config",
      "set",
      "logging.level",
      "error",
      "-c",
      configPath,
      "--if-hash",
      snapshotParsed.rawHash,
    ],
    { env: { ...process.env, MOZI_CLI: "true" } },
  );
  expect(conflict.status).toBe(2);
  expect(conflict.stderr.toString()).toContain("Config write rejected: conflict detected");
});

test("config --doctor succeeds for runnable config", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mozi-config-doctor-ok-"));
  const configPath = path.join(tmpDir, "config.jsonc");
  fs.writeFileSync(configPath, JSON.stringify(BASE_CONFIG, null, 2), "utf-8");

  const doctor = spawnSync("tsx", [CLI_PATH, "config", "--doctor", "-c", configPath], {
    env: { ...process.env, MOZI_CLI: "true" },
  });
  expect(doctor.status).toBe(0);
  expect(doctor.stdout.toString()).toContain("Config check passed. The config is runnable.");
});

test("config --doctor fails for invalid runnable state", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mozi-config-doctor-bad-"));
  const configPath = path.join(tmpDir, "config.jsonc");
  const invalid = {
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
    },
    channels: {
      telegram: { enabled: true },
    },
  };
  fs.writeFileSync(configPath, JSON.stringify(invalid, null, 2), "utf-8");

  const doctor = spawnSync("tsx", [CLI_PATH, "config", "--doctor", "-c", configPath], {
    env: { ...process.env, MOZI_CLI: "true" },
  });
  expect(doctor.status).toBe(1);
  expect(doctor.stderr.toString()).toContain("Config check failed with blocking issues");
  expect(doctor.stderr.toString()).toContain("No agents configured");
});

test("config patch rolls back when runnable checks fail", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mozi-config-rollback-"));
  const configPath = path.join(tmpDir, "config.jsonc");
  fs.writeFileSync(configPath, JSON.stringify(BASE_CONFIG, null, 2), "utf-8");
  const before = fs.readFileSync(configPath, "utf-8");

  const badPatch = spawnSync(
    "tsx",
    [CLI_PATH, "config", "patch", '{"channels":{"telegram":{"enabled":true}}}', "-c", configPath],
    { env: { ...process.env, MOZI_CLI: "true" } },
  );
  expect(badPatch.status).toBe(1);
  expect(badPatch.stderr.toString()).toContain("rejected by config checks");
  expect(badPatch.stderr.toString()).toContain("Telegram is enabled but botToken is missing");

  const after = fs.readFileSync(configPath, "utf-8");
  expect(after).toBe(before);
});

test("config doctor fails when sentinel is persisted in required secret field", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mozi-config-doctor-secret-"));
  const configPath = path.join(tmpDir, "config.jsonc");
  const bad = {
    ...BASE_CONFIG,
    channels: {
      telegram: {
        enabled: true,
        botToken: CONFIG_REDACTION_SENTINEL,
      },
    },
  };
  fs.writeFileSync(configPath, JSON.stringify(bad, null, 2), "utf-8");

  const doctor = spawnSync("tsx", [CLI_PATH, "config", "--doctor", "-c", configPath], {
    env: { ...process.env, MOZI_CLI: "true" },
  });
  expect(doctor.status).toBe(1);
  expect(doctor.stderr.toString()).toContain("redacted sentinel");
});
