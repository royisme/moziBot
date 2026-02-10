import fs from "node:fs/promises";
import path from "node:path";
import { expect, test, describe, beforeAll } from "vitest";
import { ensureHome, loadHomeFiles, buildContextFromFiles, HOME_FILES } from "./home";
import {
  ensureWorkspace,
  loadWorkspaceFiles,
  buildWorkspaceContext,
  WORKSPACE_FILES,
} from "./workspace";

const TEST_HOME = path.join(__dirname, "../../test-home");
const TEST_WORKSPACE = path.join(__dirname, "../../test-workspace");

describe("Home", () => {
  beforeAll(async () => {
    try {
      await fs.rm(TEST_HOME, { recursive: true, force: true });
    } catch {}
  });

  test("ensureHome should create directory and default files", async () => {
    await ensureHome(TEST_HOME);

    const stats = await fs.stat(TEST_HOME);
    expect(stats.isDirectory()).toBe(true);

    for (const filename of Object.values(HOME_FILES)) {
      const filePath = path.join(TEST_HOME, filename);
      const exists = await fs
        .access(filePath)
        .then(() => true)
        .catch(() => false);
      expect(exists).toBe(true);
    }
  });

  test("loadHomeFiles should load files content", async () => {
    // Modify one file
    const agentsPath = path.join(TEST_HOME, HOME_FILES.AGENTS);
    await fs.writeFile(agentsPath, "Custom Agent Content\n");

    const files = await loadHomeFiles(TEST_HOME);
    // HOME_CONTEXT_FILES excludes BOOTSTRAP
    expect(files.length).toBeGreaterThan(0);

    const agentsFile = files.find((f) => f.name === HOME_FILES.AGENTS);
    expect(agentsFile?.content).toBe("Custom Agent Content\n");
    expect(agentsFile?.missing).toBe(false);
  });

  test("buildContextFromFiles should format content correctly", async () => {
    const files = [
      { name: "A.md", path: "A.md", content: "Content A", missing: false },
      { name: "B.md", path: "B.md", content: "Content B", missing: false },
      { name: "C.md", path: "C.md", content: "", missing: false },
      { name: "D.md", path: "D.md", content: "Should not show", missing: true },
    ];

    const context = buildContextFromFiles(files);
    expect(context).toContain("## A.md\n\nContent A");
    expect(context).toContain("## B.md\n\nContent B");
    expect(context).not.toContain("## C.md");
    expect(context).not.toContain("Should not show");
  });
});

describe("Workspace", () => {
  beforeAll(async () => {
    try {
      await fs.rm(TEST_WORKSPACE, { recursive: true, force: true });
    } catch {}
  });

  test("ensureWorkspace should create directory and TOOLS.md", async () => {
    await ensureWorkspace(TEST_WORKSPACE);

    const stats = await fs.stat(TEST_WORKSPACE);
    expect(stats.isDirectory()).toBe(true);

    const toolsPath = path.join(TEST_WORKSPACE, WORKSPACE_FILES.TOOLS);
    const exists = await fs
      .access(toolsPath)
      .then(() => true)
      .catch(() => false);
    expect(exists).toBe(true);
  });

  test("loadWorkspaceFiles should load TOOLS.md content", async () => {
    const toolsPath = path.join(TEST_WORKSPACE, WORKSPACE_FILES.TOOLS);
    await fs.writeFile(toolsPath, "My Tools Notes\n");

    const files = await loadWorkspaceFiles(TEST_WORKSPACE);
    expect(files.length).toBe(1);

    const toolsFile = files.find((f) => f.name === WORKSPACE_FILES.TOOLS);
    expect(toolsFile?.content).toBe("My Tools Notes\n");
    expect(toolsFile?.missing).toBe(false);
  });

  test("buildWorkspaceContext should include path and TOOLS.md", async () => {
    const files = [{ name: "TOOLS.md", path: "TOOLS.md", content: "Tool content", missing: false }];

    const context = buildWorkspaceContext(files, "/path/to/workspace");
    expect(context).toContain("# Workspace");
    expect(context).toContain("Path: /path/to/workspace");
    expect(context).toContain("## TOOLS.md");
    expect(context).toContain("Tool content");
  });
});
