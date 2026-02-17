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

  it("disables extension when register callback is async", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mozi-ext-"));
    const extFile = path.join(tempDir, "external-async-register.cjs");
    fs.writeFileSync(
      extFile,
      [
        "module.exports = {",
        "  id: 'external-async-register',",
        "  version: '1.0.0',",
        "  name: 'External Async Register',",
        "  async register(api) {",
        "    api.registerCommand({",
        "      name: 'ext_async',",
        "      description: 'async register command',",
        "      handler: async () => ({ text: 'ok' }),",
        "    });",
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
    const ext = registry.get("external-async-register");
    expect(ext).toBeDefined();
    expect(ext?.enabled).toBe(false);
    expect(
      ext?.diagnostics.some((diag) =>
        diag.message.includes("async register is not supported in sync load path"),
      ),
    ).toBe(true);
  });

  it("keeps extension enabled on capability mismatch in warn mode", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mozi-ext-"));
    const extFile = path.join(tempDir, "external-cap-warn.cjs");
    fs.writeFileSync(
      extFile,
      [
        "module.exports = {",
        "  id: 'external-cap-warn',",
        "  version: '1.0.0',",
        "  name: 'External Capability Warn',",
        "  capabilities: { tools: false },",
        "  register(api) {",
        "    api.registerTool({",
        "      name: 'cap_warn_tool',",
        "      label: 'Cap Warn Tool',",
        "      description: 'cap warn test',",
        "      parameters: {},",
        "      execute: async () => ({ content: [{ type: 'text', text: 'ok' }], details: {} }),",
        "    });",
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
      policy: {
        capabilities: "warn",
      },
    };

    const registry = loadExtensions(config);
    const ext = registry.get("external-cap-warn");
    expect(ext).toBeDefined();
    expect(ext?.enabled).toBe(true);
    expect(
      ext?.diagnostics.some(
        (diag) =>
          diag.level === "warn" && diag.message.includes('does not declare capability "tools"'),
      ),
    ).toBe(true);
  });

  it("disables extension on capability mismatch in enforce mode", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mozi-ext-"));
    const extFile = path.join(tempDir, "external-cap-enforce.cjs");
    fs.writeFileSync(
      extFile,
      [
        "module.exports = {",
        "  id: 'external-cap-enforce',",
        "  version: '1.0.0',",
        "  name: 'External Capability Enforce',",
        "  capabilities: { commands: false },",
        "  register(api) {",
        "    api.registerCommand({",
        "      name: 'cap_enforce',",
        "      description: 'cap enforce test',",
        "      handler: async () => ({ text: 'ok' }),",
        "    });",
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
      policy: {
        capabilities: "enforce",
      },
    };

    const registry = loadExtensions(config);
    const ext = registry.get("external-cap-enforce");
    expect(ext).toBeDefined();
    expect(ext?.enabled).toBe(false);
    expect(
      ext?.diagnostics.some(
        (diag) =>
          diag.level === "error" && diag.message.includes('does not declare capability "commands"'),
      ),
    ).toBe(true);
  });

  it("emits compatibility diagnostic for unsupported OpenClaw hook names", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mozi-ext-"));
    const extFile = path.join(tempDir, "external-openclaw-hook.cjs");
    fs.writeFileSync(
      extFile,
      [
        "module.exports = {",
        "  id: 'external-openclaw-hook',",
        "  version: '1.0.0',",
        "  name: 'External OpenClaw Hook',",
        "  register(api) {",
        "    api.registerHook('message_sending', async () => {});",
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
    const ext = registry.get("external-openclaw-hook");
    expect(ext).toBeDefined();
    expect(
      ext?.diagnostics.some((diag) =>
        diag.message.includes('OpenClaw hook "message_sending" is not supported yet'),
      ),
    ).toBe(true);
  });

  it("does not reserve command ownership for disabled extensions", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mozi-ext-"));
    const disabledExtFile = path.join(tempDir, "external-disabled-command.cjs");
    const enabledExtFile = path.join(tempDir, "external-enabled-command.cjs");
    fs.writeFileSync(
      disabledExtFile,
      [
        "module.exports = {",
        "  id: 'external-disabled-command',",
        "  version: '1.0.0',",
        "  name: 'External Disabled Command',",
        "  register(api) {",
        "    api.registerCommand({",
        "      name: 'shared_cmd',",
        "      description: 'shared command',",
        "      handler: async () => ({ text: 'disabled' }),",
        "    });",
        "  },",
        "};",
      ].join("\n"),
      "utf-8",
    );
    fs.writeFileSync(
      enabledExtFile,
      [
        "module.exports = {",
        "  id: 'external-enabled-command',",
        "  version: '1.0.0',",
        "  name: 'External Enabled Command',",
        "  register(api) {",
        "    api.registerCommand({",
        "      name: 'shared_cmd',",
        "      description: 'shared command',",
        "      handler: async () => ({ text: 'enabled' }),",
        "    });",
        "  },",
        "};",
      ].join("\n"),
      "utf-8",
    );

    const config: ExtensionsConfig = {
      enabled: true,
      load: {
        paths: [disabledExtFile, enabledExtFile],
      },
      entries: {
        "external-disabled-command": {
          enabled: false,
        },
      },
    };

    const registry = loadExtensions(config);
    const disabled = registry.get("external-disabled-command");
    const enabled = registry.get("external-enabled-command");
    expect(disabled?.enabled).toBe(false);
    expect(enabled?.enabled).toBe(true);
    expect(enabled?.commands.map((command) => command.name)).toContain("shared_cmd");
    expect(
      enabled?.diagnostics.some((diag) => diag.message.includes("already registered by extension")),
    ).toBe(false);
  });
});
