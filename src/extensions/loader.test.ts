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
});
