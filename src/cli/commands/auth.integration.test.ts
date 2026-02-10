import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "vitest";

const CLI_PATH = "src/cli/index.ts";

test("auth set/list/remove works with config-scoped .env", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mozi-auth-"));
  const configPath = path.join(tmpDir, "config.jsonc");
  fs.writeFileSync(configPath, "{}", "utf-8");

  const set = spawnSync(
    "tsx",
    [CLI_PATH, "auth", "set", "tavily", "-c", configPath, "--value", "tvly-test-key"],
    { env: { ...process.env, MOZI_CLI: "true" } },
  );
  expect(set.status).toBe(0);
  expect(set.stdout.toString()).toContain("Saved TAVILY_API_KEY");

  const envPath = path.join(tmpDir, ".env");
  const envContent = fs.readFileSync(envPath, "utf-8");
  expect(envContent).toContain("TAVILY_API_KEY=tvly-test-key");

  const list = spawnSync("tsx", [CLI_PATH, "auth", "list", "-c", configPath], {
    env: { ...process.env, MOZI_CLI: "true" },
  });
  expect(list.status).toBe(0);
  expect(list.stdout.toString()).toContain("TAVILY_API_KEY");
  expect(list.stdout.toString()).toContain("set (.env)");

  const remove = spawnSync("tsx", [CLI_PATH, "auth", "remove", "tavily", "-c", configPath], {
    env: { ...process.env, MOZI_CLI: "true" },
  });
  expect(remove.status).toBe(0);
  expect(remove.stdout.toString()).toContain("Removed TAVILY_API_KEY");

  const listAfter = spawnSync("tsx", [CLI_PATH, "auth", "list", "-c", configPath], {
    env: { ...process.env, MOZI_CLI: "true" },
  });
  expect(listAfter.status).toBe(0);
  expect(listAfter.stdout.toString()).toContain("not set");
});
