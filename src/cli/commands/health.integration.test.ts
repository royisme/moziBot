import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "vitest";

const CLI_PATH = "src/cli/index.ts";

test("health accepts JSONC config syntax and reports configuration as valid", () => {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "mozi-health-home-"));
  const baseDir = path.join(tempHome, ".mozi");
  const homeDir = path.join(baseDir, "agents", "main", "home");
  const workspaceDir = path.join(baseDir, "agents", "main", "workspace");

  fs.mkdirSync(homeDir, { recursive: true });
  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.writeFileSync(path.join(homeDir, "AGENTS.md"), "# AGENTS\n", "utf-8");
  fs.writeFileSync(path.join(homeDir, "SOUL.md"), "# SOUL\n", "utf-8");
  fs.writeFileSync(path.join(homeDir, "IDENTITY.md"), "# IDENTITY\n", "utf-8");

  const configPath = path.join(baseDir, "config.jsonc");
  const configJsonc = `{
  // jsonc comment
  "models": {
    "providers": {
      "openai": {
        "api": "openai-responses",
        "apiKey": "test-key",
        "models": [{ "id": "gpt-4o-mini" }],
      },
    },
  },
  "agents": {
    "defaults": { "model": "openai/gpt-4o-mini" },
    "mozi": {
      "main": true,
      "home": "${homeDir.replace(/\\/g, "\\\\")}",
      "workspace": "${workspaceDir.replace(/\\/g, "\\\\")}",
    },
  },
}`;
  fs.mkdirSync(baseDir, { recursive: true });
  fs.writeFileSync(configPath, configJsonc, "utf-8");

  const run = spawnSync("tsx", [CLI_PATH, "health"], {
    env: { ...process.env, HOME: tempHome, MOZI_CLI: "true" },
  });

  expect(run.status).toBe(0);
  expect(run.stdout.toString()).toContain("Configuration");
  expect(run.stdout.toString()).not.toContain("Invalid config");
});
