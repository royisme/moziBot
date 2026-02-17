import { describe, expect, it } from "vitest";
import type { LoadedExtension } from "./types";
import { ExtensionRegistry } from "./registry";

function makeExtension(
  id: string,
  enabled: boolean,
  toolNames: string[] = [],
  skillDirs: string[] = [],
): LoadedExtension {
  return {
    manifest: {
      id,
      version: "1.0.0",
      name: `Extension ${id}`,
      tools: toolNames.map((name) => ({
        name,
        label: name,
        description: `Tool ${name}`,
        parameters: {},
        execute: async () => ({
          content: [{ type: "text", text: "ok" }],
          details: {},
        }),
      })),
      skillDirs: skillDirs.length > 0 ? skillDirs : undefined,
    },
    source: `test:${id}`,
    tools: toolNames.map((name) => ({
      name,
      label: name,
      description: `Tool ${name}`,
      parameters: {},
      execute: async () => ({
        content: [{ type: "text", text: "ok" }],
        details: {},
      }),
    })),
    hooks: [],
    commands: [],
    enabled,
    diagnostics: [],
  };
}

describe("ExtensionRegistry", () => {
  it("registers and retrieves extensions", () => {
    const registry = new ExtensionRegistry();
    const ext = makeExtension("test", true, ["tool1"]);
    registry.register(ext);

    expect(registry.get("test")).toBe(ext);
    expect(registry.list()).toHaveLength(1);
  });

  it("overwrites duplicate IDs", () => {
    const registry = new ExtensionRegistry();
    registry.register(makeExtension("test", true, ["tool1"]));
    registry.register(makeExtension("test", false, ["tool2"]));

    expect(registry.list()).toHaveLength(1);
    expect(registry.get("test")?.enabled).toBe(false);
  });

  it("collects tools only from enabled extensions", () => {
    const registry = new ExtensionRegistry();
    registry.register(makeExtension("a", true, ["tool_a"]));
    registry.register(makeExtension("b", false, ["tool_b"]));
    registry.register(makeExtension("c", true, ["tool_c"]));

    const tools = registry.collectTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain("tool_a");
    expect(names).toContain("tool_c");
    expect(names).not.toContain("tool_b");
  });

  it("collects skill dirs only from enabled extensions", () => {
    const registry = new ExtensionRegistry();
    registry.register(makeExtension("a", true, [], ["/skills/a"]));
    registry.register(makeExtension("b", false, [], ["/skills/b"]));

    const dirs = registry.collectSkillDirs();
    expect(dirs).toContain("/skills/a");
    expect(dirs).not.toContain("/skills/b");
  });

  it("collects hooks only from enabled extensions", () => {
    const registry = new ExtensionRegistry();
    const enabled = makeExtension("enabled", true);
    enabled.hooks.push({
      hookName: "turn_completed",
      handler: () => {},
      priority: 1,
    });
    const disabled = makeExtension("disabled", false);
    disabled.hooks.push({
      hookName: "turn_completed",
      handler: () => {},
    });
    registry.register(enabled);
    registry.register(disabled);

    const hooks = registry.collectHooks();
    expect(hooks).toHaveLength(1);
    expect(hooks[0]?.extensionId).toBe("enabled");
    expect(hooks[0]?.hook.hookName).toBe("turn_completed");
  });

  it("finds and executes extension command", async () => {
    const registry = new ExtensionRegistry();
    const ext = makeExtension("commands", true);
    ext.commands.push({
      name: "ping",
      description: "ping command",
      handler: async () => ({ text: "pong" }),
    });
    registry.register(ext);

    const sent: string[] = [];
    const handled = await registry.executeCommand({
      commandName: "ping",
      args: "",
      sessionKey: "s1",
      agentId: "a1",
      peerId: "p1",
      channelId: "telegram",
      message: { text: "/ping" },
      sendReply: async (text) => {
        sent.push(text);
      },
    });

    expect(handled).toBe(true);
    expect(sent).toEqual(["pong"]);
  });

  it("accumulates diagnostics from all sources", () => {
    const registry = new ExtensionRegistry();
    registry.addDiagnostics([{ extensionId: "global", level: "warn", message: "global warning" }]);

    const ext = makeExtension("test", true);
    ext.diagnostics.push({ extensionId: "test", level: "info", message: "test info" });
    registry.register(ext);

    const diags = registry.getDiagnostics();
    expect(diags).toHaveLength(2);
    expect(diags.some((d) => d.message === "global warning")).toBe(true);
    expect(diags.some((d) => d.message === "test info")).toBe(true);
  });

  it("clears all state", () => {
    const registry = new ExtensionRegistry();
    registry.register(makeExtension("a", true, ["tool"]));
    registry.addDiagnostics([{ extensionId: "a", level: "info", message: "msg" }]);
    registry.clear();

    expect(registry.list()).toHaveLength(0);
    expect(registry.getDiagnostics()).toHaveLength(0);
  });

  it("invokes onStop lifecycle callbacks during shutdown", async () => {
    const calls: string[] = [];
    const registry = new ExtensionRegistry();

    const ext = makeExtension("lifecycle", true);
    ext.manifest.onStop = async () => {
      calls.push("stopped");
    };
    ext.extensionConfig = { test: true };

    registry.register(ext);
    await registry.shutdown();

    expect(calls).toEqual(["stopped"]);
  });

  it("invokes onReload lifecycle callbacks for extensions that existed before reload", async () => {
    const calls: string[] = [];
    const registry = new ExtensionRegistry();

    const persisted = makeExtension("persisted", true);
    persisted.manifest.onReload = async () => {
      calls.push("persisted");
    };

    const fresh = makeExtension("fresh", true);
    fresh.manifest.onReload = async () => {
      calls.push("fresh");
    };

    registry.register(persisted);
    registry.register(fresh);

    await registry.notifyReload(["persisted"]);

    expect(calls).toEqual(["persisted"]);
  });

  it("records diagnostics when onReload lifecycle callback fails", async () => {
    const registry = new ExtensionRegistry();
    const ext = makeExtension("reload-failure", true);
    ext.manifest.onReload = async () => {
      throw new Error("reload-failed");
    };
    registry.register(ext);

    await registry.notifyReload(["reload-failure"]);

    expect(
      registry
        .getDiagnostics()
        .some((diag) => diag.message.includes("Extension onReload failed: reload-failed")),
    ).toBe(true);
  });
});
