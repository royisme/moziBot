import { spawnSync } from "node:child_process";
import { test, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CLI_PATH = "src/cli/index.ts";

test("help output", async () => {
  const { stdout, status } = spawnSync("tsx", [CLI_PATH, "--help"], {
    env: { ...process.env, MOZI_CLI: "true" },
  });
  expect(status).toBe(0);
  expect(stdout.toString()).toContain("Usage: mozi");
  expect(stdout.toString()).toContain("runtime");
  expect(stdout.toString()).toContain("sandbox");
  expect(stdout.toString()).toContain("auth");
  expect(stdout.toString()).toContain("chat");
});

test("version flag", async () => {
  const { stdout, status } = spawnSync("tsx", [CLI_PATH, "--version"], {
    env: { ...process.env, MOZI_CLI: "true" },
  });
  expect(status).toBe(0);
  expect(stdout.toString().trim()).toBe("1.0.2");
});

test("runtime help", async () => {
  const { stdout, status } = spawnSync("tsx", [CLI_PATH, "runtime", "--help"], {
    env: { ...process.env, MOZI_CLI: "true" },
  });
  expect(status).toBe(0);
  expect(stdout.toString()).toContain("Manage Mozi Runtime");
});

test("doctor succeeds with minimal off-mode runnable config", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mozi-doctor-"));
  const configPath = path.join(tmpDir, "config.jsonc");
  const config = {
    models: {
      providers: {
        openai: {
          api: "openai-responses",
          models: [{ id: "gpt-4o-mini" }],
        },
      },
    },
    agents: {
      defaults: { model: "openai/gpt-4o-mini" },
      mozi: {
        main: true,
        sandbox: { mode: "off" },
      },
    },
  };
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");

  const { stdout, stderr, status } = spawnSync("tsx", [CLI_PATH, "doctor", "-c", configPath], {
    env: { ...process.env, MOZI_CLI: "true" },
  });

  expect(status).toBe(0);
  expect(stdout.toString()).toContain("Configuration looks runnable");
  expect(stderr.toString()).not.toContain("blocking issues");
});

test("doctor --fix succeeds with minimal off-mode runnable config", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mozi-doctor-fix-"));
  const configPath = path.join(tmpDir, "config.jsonc");
  const config = {
    models: {
      providers: {
        openai: {
          api: "openai-responses",
          models: [{ id: "gpt-4o-mini" }],
        },
      },
    },
    agents: {
      defaults: { model: "openai/gpt-4o-mini" },
      mozi: {
        main: true,
        sandbox: { mode: "off" },
      },
    },
  };
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");

  const { stdout, stderr, status } = spawnSync(
    "tsx",
    [CLI_PATH, "doctor", "-c", configPath, "--fix"],
    { env: { ...process.env, MOZI_CLI: "true" } },
  );

  expect(status).toBe(0);
  expect(stdout.toString()).toContain("Configuration looks runnable");
  expect(stderr.toString()).not.toContain("blocking issues");
});
