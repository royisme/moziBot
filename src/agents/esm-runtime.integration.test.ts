import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { execa } from "execa";
import { afterEach, describe, expect, it } from "vitest";

let baseDir = "";

afterEach(async () => {
  if (baseDir) {
    await fs.rm(baseDir, { recursive: true, force: true });
    baseDir = "";
  }
});

describe("ESM runtime (templates)", () => {
  it("loads home/workspace templates under a real ESM loader", async () => {
    baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "mozi-esm-"));
    const homeDir = path.join(baseDir, "home");
    const workspaceDir = path.join(baseDir, "workspace");

    const homeUrl = pathToFileURL(path.join(process.cwd(), "src/agents/home.ts")).href;
    const workspaceUrl = pathToFileURL(path.join(process.cwd(), "src/agents/workspace.ts")).href;

    const script = [
      `import { ensureHome } from ${JSON.stringify(homeUrl)};`,
      `import { ensureWorkspace } from ${JSON.stringify(workspaceUrl)};`,
      `await ensureHome(${JSON.stringify(homeDir)});`,
      `await ensureWorkspace(${JSON.stringify(workspaceDir)});`,
      "process.exit(0);",
    ].join("\n");

    await execa("node", ["--import", "tsx/esm", "--input-type=module", "-e", script], {
      env: { ...process.env, NODE_ENV: "test" },
    });

    await expect(fs.access(path.join(homeDir, "AGENTS.md"))).resolves.toBeUndefined();
    await expect(fs.access(path.join(workspaceDir, "WORK.md"))).resolves.toBeUndefined();
  });
});
