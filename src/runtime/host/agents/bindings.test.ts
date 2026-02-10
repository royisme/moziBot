import { beforeEach, describe, expect, it } from "vitest";
import type { AgentConfig, Binding } from "./types";
import { AgentBindings } from "./bindings";

describe("AgentBindings", () => {
  let bindings: AgentBindings;

  const agents: AgentConfig[] = [
    { id: "main", workspace: "main-ws", name: "Main Agent" },
    { id: "support", workspace: "support-ws", name: "Support Agent" },
    { id: "dev", workspace: "dev-ws", name: "Dev Agent" },
  ];

  beforeEach(() => {
    bindings = new AgentBindings();
  });

  it("should load agents and bindings", () => {
    bindings.load({ agents });
    expect(bindings.listAgents().length).toBe(3);
    expect(bindings.getAgent("main")?.id).toBe("main");
  });

  it("should fallback to default agent", () => {
    bindings.load({ agents, defaultAgent: "main" });
    const resolved = bindings.resolve({
      channel: "any",
      peerId: "any",
      peerKind: "dm",
    });
    expect(resolved.id).toBe("main");
  });

  it("should match by channel", () => {
    const configBindings: Binding[] = [{ agentId: "support", match: { channel: "slack" } }];
    bindings.load({ agents, bindings: configBindings, defaultAgent: "main" });

    const resolvedSlack = bindings.resolve({
      channel: "slack",
      peerId: "user1",
      peerKind: "dm",
    });
    expect(resolvedSlack.id).toBe("support");

    const resolvedOther = bindings.resolve({
      channel: "telegram",
      peerId: "user1",
      peerKind: "dm",
    });
    expect(resolvedOther.id).toBe("main");
  });

  it("should match by peer id", () => {
    const configBindings: Binding[] = [{ agentId: "dev", match: { peer: { id: "roy" } } }];
    bindings.load({ agents, bindings: configBindings, defaultAgent: "main" });

    const resolvedRoy = bindings.resolve({
      channel: "telegram",
      peerId: "roy",
      peerKind: "dm",
    });
    expect(resolvedRoy.id).toBe("dev");

    const resolvedOther = bindings.resolve({
      channel: "telegram",
      peerId: "other",
      peerKind: "dm",
    });
    expect(resolvedOther.id).toBe("main");
  });

  it("should match by peer kind", () => {
    const configBindings: Binding[] = [{ agentId: "support", match: { peer: { kind: "group" } } }];
    bindings.load({ agents, bindings: configBindings, defaultAgent: "main" });

    const resolvedGroup = bindings.resolve({
      channel: "telegram",
      peerId: "group1",
      peerKind: "group",
    });
    expect(resolvedGroup.id).toBe("support");

    const resolvedDM = bindings.resolve({
      channel: "telegram",
      peerId: "user1",
      peerKind: "dm",
    });
    expect(resolvedDM.id).toBe("main");
  });

  it("should respect binding priority (first match wins)", () => {
    const configBindings: Binding[] = [
      { agentId: "dev", match: { peer: { id: "roy" } } },
      { agentId: "support", match: { channel: "telegram" } },
    ];
    bindings.load({ agents, bindings: configBindings, defaultAgent: "main" });

    // Roy on Telegram should match "dev" because it's first
    const resolved = bindings.resolve({
      channel: "telegram",
      peerId: "roy",
      peerKind: "dm",
    });
    expect(resolved.id).toBe("dev");

    // Other on Telegram should match "support"
    const resolvedOther = bindings.resolve({
      channel: "telegram",
      peerId: "other",
      peerKind: "dm",
    });
    expect(resolvedOther.id).toBe("support");
  });

  it("should match exact peer (id AND kind)", () => {
    const configBindings: Binding[] = [
      { agentId: "dev", match: { peer: { id: "roy", kind: "dm" } } },
    ];
    bindings.load({ agents, bindings: configBindings, defaultAgent: "main" });

    const resolvedMatch = bindings.resolve({
      channel: "any",
      peerId: "roy",
      peerKind: "dm",
    });
    expect(resolvedMatch.id).toBe("dev");

    const resolvedNoMatch = bindings.resolve({
      channel: "any",
      peerId: "roy",
      peerKind: "group",
    });
    expect(resolvedNoMatch.id).toBe("main");
  });
});
