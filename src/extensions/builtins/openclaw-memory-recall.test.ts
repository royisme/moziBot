import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionsConfig } from "../../config/schema/extensions";
import type { RuntimeHookHandlerMap } from "../../runtime/hooks/types";
import { loadExtensions } from "../loader";
import "../builtins";

const createdDirs: string[] = [];

async function createTempBaseDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mozi-openclaw-memory-recall-"));
  createdDirs.push(dir);
  return dir;
}

async function writeMemoryFile(params: {
  baseDir: string;
  agentId: string;
  content: string;
}): Promise<void> {
  const homeDir = path.join(params.baseDir, "agents", params.agentId, "home");
  await fs.mkdir(homeDir, { recursive: true });
  await fs.writeFile(path.join(homeDir, "MEMORY.md"), params.content, "utf-8");
}

function loadBeforeAgentStartHook(
  config: ExtensionsConfig,
): RuntimeHookHandlerMap["before_agent_start"] {
  const registry = loadExtensions(config);
  const ext = registry.get("openclaw-memory-recall");
  expect(ext).toBeDefined();
  expect(ext?.enabled).toBe(true);
  const hook = ext?.hooks.find((item) => item.hookName === "before_agent_start");
  expect(hook).toBeDefined();
  return hook?.handler as RuntimeHookHandlerMap["before_agent_start"];
}

describe("openclaw-memory-recall extension", () => {
  afterEach(async () => {
    for (const dir of createdDirs.splice(0)) {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("injects relevant MEMORY.md lines for before_agent_start", async () => {
    const baseDir = await createTempBaseDir();
    const agentId = "mozi";
    await writeMemoryFile({
      baseDir,
      agentId,
      content: [
        "# Memory",
        "- 默认用中文回复用户。",
        "- Project uses pnpm for package management.",
        "- Keep responses concise unless user asks for detail.",
      ].join("\n"),
    });

    const handler = loadBeforeAgentStartHook({
      enabled: true,
      entries: {
        "openclaw-memory-recall": {
          enabled: true,
          config: {
            baseDir,
            maxItems: 2,
          },
        },
      },
    });

    const result = await handler(
      { promptText: "请继续用中文回答，并给我 pnpm 相关命令。" },
      { sessionKey: "s1", agentId, traceId: "t1", messageId: "m1" },
    );

    expect(result?.promptText).toContain("[Relevant memory from MEMORY.md]");
    expect(result?.promptText).toContain("默认用中文回复用户");
    expect(result?.promptText).toContain("pnpm");
    expect(result?.promptText).toContain("请继续用中文回答，并给我 pnpm 相关命令。");
  });

  it("skips injection when no relevant lines match prompt", async () => {
    const baseDir = await createTempBaseDir();
    const agentId = "mozi";
    await writeMemoryFile({
      baseDir,
      agentId,
      content: [
        "# Memory",
        "- Use pnpm workspace mode.",
        "- Prefer Chinese responses in group chats.",
      ].join("\n"),
    });

    const handler = loadBeforeAgentStartHook({
      enabled: true,
      entries: {
        "openclaw-memory-recall": {
          enabled: true,
          config: {
            baseDir,
          },
        },
      },
    });

    const result = await handler(
      { promptText: "Let us discuss astrophysics and black holes." },
      { sessionKey: "s1", agentId, traceId: "t1", messageId: "m1" },
    );

    expect(result).toBeUndefined();
  });

  it("skips injection when agentId is missing", async () => {
    const baseDir = await createTempBaseDir();
    await writeMemoryFile({
      baseDir,
      agentId: "mozi",
      content: "# Memory\n- Prefer Chinese replies.",
    });

    const handler = loadBeforeAgentStartHook({
      enabled: true,
      entries: {
        "openclaw-memory-recall": {
          enabled: true,
          config: {
            baseDir,
          },
        },
      },
    });

    const result = await handler(
      { promptText: "Please continue in Chinese." },
      { sessionKey: "s1", traceId: "t1", messageId: "m1" },
    );

    expect(result).toBeUndefined();
  });
});
