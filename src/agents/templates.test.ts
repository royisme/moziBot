import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { resetTemplatesDirCache, resolveTemplatePath, resolveTemplatesDir } from "./templates";

const REQUIRED = [
  "AGENTS.md",
  "SOUL.md",
  "IDENTITY.md",
  "USER.md",
  "MEMORY.md",
  "BOOTSTRAP.md",
  "HEARTBEAT.md",
  "WORK.md",
  "TOOLS.md",
] as const;

const tempDirs: string[] = [];

async function makeTempRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mozi-templates-"));
  tempDirs.push(root);
  return root;
}

async function seedTemplates(dir: string, files: readonly string[] = REQUIRED): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  await Promise.all(files.map((file) => fs.writeFile(path.join(dir, file), `# ${file}\n`)));
}

describe("resolveTemplatesDir", () => {
  afterEach(async () => {
    delete process.env.MOZI_TEMPLATES_DIR;
    resetTemplatesDirCache();
    await Promise.all(
      tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
    );
  });

  it("prefers complete package-root src templates over incomplete dist templates", async () => {
    const root = await makeTempRoot();
    await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ name: "mozi" }));

    const srcTemplates = path.join(root, "src", "agents", "templates");
    await seedTemplates(srcTemplates);

    const distTemplates = path.join(root, "dist", "templates");
    await seedTemplates(distTemplates, ["AGENTS.md", "WORK.md"]);

    const moduleUrl = pathToFileURL(path.join(root, "dist", "agents", "templates.js")).toString();
    const resolved = resolveTemplatesDir({ cwd: path.join(root, "dist"), moduleUrl });

    expect(resolved).toBe(srcTemplates);
    expect(resolveTemplatePath("USER.md")).toBe(path.join(srcTemplates, "USER.md"));
  });

  it("uses MOZI_TEMPLATES_DIR override when directory exists", async () => {
    const root = await makeTempRoot();
    const overrideDir = path.join(root, "override-templates");
    await fs.mkdir(overrideDir, { recursive: true });
    process.env.MOZI_TEMPLATES_DIR = overrideDir;

    const resolved = resolveTemplatesDir({ cwd: root, moduleUrl: import.meta.url });

    expect(resolved).toBe(overrideDir);
  });
});
