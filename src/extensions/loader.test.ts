import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ExtensionsConfig } from "../config/schema/extensions";
import { initExtensionsAsync, loadExtensions } from "./loader";
import "./builtins";

// The builtin web-tavily extension is auto-registered via the builtins/index import

describe("loadExtensions", () => {
  it("returns empty registry when config is undefined", () => {
    const registry = loadExtensions(undefined);
    expect(registry.list()).toHaveLength(0);
  });

  it("returns empty registry when extensions are disabled", () => {
    const config: ExtensionsConfig = { enabled: false };
    const registry = loadExtensions(config);
    expect(registry.list()).toHaveLength(0);
  });

  it("loads web-tavily builtin when enabled", () => {
    const config: ExtensionsConfig = {
      enabled: true,
      entries: {
        "web-tavily": {
          enabled: true,
          config: {
            apiKeyEnv: "TAVILY_API_KEY",
          },
        },
      },
    };
    const registry = loadExtensions(config);
    const ext = registry.get("web-tavily");
    expect(ext).toBeDefined();
    expect(ext?.enabled).toBe(true);
    expect(ext?.manifest.id).toBe("web-tavily");
    expect(ext?.tools.length).toBeGreaterThan(0);
    expect(ext?.tools.some((t) => t.name === "web_search")).toBe(true);
  });

  it("loads web-tavily as disabled when entry omits enabled", () => {
    const config: ExtensionsConfig = {
      enabled: true,
      entries: {
        "web-tavily": {
          config: {},
        },
      },
    };
    const registry = loadExtensions(config);
    const ext = registry.get("web-tavily");
    // Entry exists but enabled is not set, defaults to enabled !== false
    expect(ext).toBeDefined();
    expect(ext?.enabled).toBe(true);
  });

  it("does not load web-tavily when not in entries", () => {
    const config: ExtensionsConfig = {
      enabled: true,
      entries: {},
    };
    const registry = loadExtensions(config);
    const ext = registry.get("web-tavily");
    // Should be registered but disabled (no entry)
    expect(ext).toBeDefined();
    expect(ext?.enabled).toBe(false);
  });

  it("blocks web-tavily via deny list", () => {
    const config: ExtensionsConfig = {
      enabled: true,
      deny: ["web-tavily"],
      entries: {
        "web-tavily": { enabled: true },
      },
    };
    const registry = loadExtensions(config);
    const ext = registry.get("web-tavily");
    // Should not be registered at all when denied
    expect(ext).toBeUndefined();
    const diags = registry.getDiagnostics();
    expect(diags.some((d) => d.message.includes("deny"))).toBe(true);
  });

  it("blocks web-tavily when not in allow list", () => {
    const config: ExtensionsConfig = {
      enabled: true,
      allow: ["some-other-ext"],
      entries: {
        "web-tavily": { enabled: true },
      },
    };
    const registry = loadExtensions(config);
    const ext = registry.get("web-tavily");
    expect(ext).toBeUndefined();
    const diags = registry.getDiagnostics();
    expect(diags.some((d) => d.message.includes("allow"))).toBe(true);
  });

  it("collects tools from enabled extensions", () => {
    const config: ExtensionsConfig = {
      enabled: true,
      entries: {
        "web-tavily": { enabled: true },
      },
    };
    const registry = loadExtensions(config);
    const tools = registry.collectTools();
    expect(tools.some((t) => t.name === "web_search")).toBe(true);
  });

  it("does not collect tools from disabled extensions", () => {
    const config: ExtensionsConfig = {
      enabled: true,
      entries: {
        "web-tavily": { enabled: false },
      },
    };
    const registry = loadExtensions(config);
    const tools = registry.collectTools();
    expect(tools.some((t) => t.name === "web_search")).toBe(false);
  });

  it("registers disabled MCP servers without spawning", async () => {
    const config: ExtensionsConfig = {
      enabled: true,
      mcpServers: {
        "disabled-mcp": {
          command: "node",
          args: ["-e", "process.exit(0)"],
          enabled: false,
        },
      },
    };
    const registry = loadExtensions(config);
    await initExtensionsAsync(config, registry);
    const ext = registry.get("mcp:disabled-mcp");
    expect(ext).toBeDefined();
    expect(ext?.enabled).toBe(false);
    expect(ext?.tools.length).toBe(0);
  });

  it("loads external extension from load.paths and enables it by default", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mozi-ext-"));
    const extFile = path.join(tempDir, "external-test.cjs");
    fs.writeFileSync(
      extFile,
      [
        "module.exports = {",
        "  id: 'external-test',",
        "  version: '1.0.0',",
        "  name: 'External Test',",
        "  register(api) {",
        "    api.registerCommand({",
        "      name: 'ext_ping',",
        "      description: 'extension ping',",
        "      handler: async () => ({ text: 'pong from extension' }),",
        "    });",
        "    api.registerHook('turn_completed', async () => {});",
        "  },",
        "};",
      ].join("\n"),
      "utf-8",
    );

    const config: ExtensionsConfig = {
      enabled: true,
      load: {
        paths: [extFile],
      },
      entries: {},
    };

    const registry = loadExtensions(config);
    await initExtensionsAsync(config, registry);

    const ext = registry.get("external-test");
    expect(ext, JSON.stringify(registry.getDiagnostics())).toBeDefined();
    expect(ext?.enabled).toBe(true);
    expect(ext?.commands.map((cmd) => cmd.name)).toContain("ext_ping");
    expect(ext?.hooks.map((hook) => hook.hookName)).toContain("turn_completed");

    const replies: string[] = [];
    const handled = await registry.executeCommand({
      commandName: "ext_ping",
      args: "",
      sessionKey: "s1",
      agentId: "a1",
      peerId: "p1",
      channelId: "telegram",
      message: { text: "/ext_ping" },
      sendReply: async (text) => {
        replies.push(text);
      },
    });
    expect(handled).toBe(true);
    expect(replies).toEqual(["pong from extension"]);
  });
});
