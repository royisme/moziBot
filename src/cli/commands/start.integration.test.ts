import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "vitest";

const CLI_PATH = "src/cli/index.ts";

test("runtime start fails fast when config file is missing", () => {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "mozi-start-home-"));

  const run = spawnSync("tsx", [CLI_PATH, "runtime", "start", "--foreground"], {
    env: { ...process.env, HOME: tempHome, MOZI_CLI: "true" },
  });

  expect(run.status).toBe(1);
  expect(run.stderr.toString()).toContain("Error: failed to load configuration.");
});
