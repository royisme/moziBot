import { describe, expect, it, vi } from "vitest";
import {
  buildChannelContext,
  buildRuntimePathsPrompt,
  buildSandboxPrompt,
  buildSystemPrompt,
} from "./prompt-builder";

vi.mock("../../agents/home", () => ({
  checkBootstrapState: vi.fn(async () => ({
    isBootstrapping: false,
    bootstrapPath: "/tmp/home/BOOTSTRAP.md",
  })),
  loadHomeFiles: vi.fn(async () => [
    {
      name: "AGENTS.md",
      path: "/tmp/home/AGENTS.md",
      content: "Project rules first",
      missing: false,
    },
    {
      name: "SOUL.md",
      path: "/tmp/home/SOUL.md",
      content: "Be sharp and practical",
      missing: false,
    },
    {
      name: "IDENTITY.md",
      path: "/tmp/home/IDENTITY.md",
      content: "Name: Mozi",
      missing: false,
    },
    {
      name: "USER.md",
      path: "/tmp/home/USER.md",
      content: "User: Roy",
      missing: false,
    },
    {
      name: "MEMORY.md",
      path: "/tmp/home/MEMORY.md",
      content: "Remember delivery ownership",
      missing: false,
    },
    {
      name: "HEARTBEAT.md",
      path: "/tmp/home/HEARTBEAT.md",
      content: "@heartbeat enabled=on",
      missing: false,
    },
  ]),
}));

vi.mock("../../agents/workspace", () => ({
  loadWorkspaceFiles: vi.fn(async () => [
    {
      name: "WORK.md",
      path: "/tmp/workspace/WORK.md",
      content: "Workspace scope and rules",
      missing: false,
    },
    {
      name: "TOOLS.md",
      path: "/tmp/workspace/TOOLS.md",
      content: "Use project tools",
      missing: false,
    },
  ]),
}));

describe("buildSystemPrompt", () => {
  it("builds layered prompt with explicit precedence and skills last", async () => {
    const skillLoader = {
      loadAll: vi.fn(async () => {}),
      syncHomeIndex: vi.fn(async () => {}),
      formatForPrompt: vi.fn(() => "skill-a\nskill-b"),
    };

    const prompt = await buildSystemPrompt({
      homeDir: "/tmp/home",
      workspaceDir: "/tmp/workspace",
      basePrompt: "Base runtime directives",
      skills: ["skill-a"],
      tools: ["bash", "read", "skills_note"],
      skillLoader: skillLoader as never,
      skillsIndexSynced: new Set<string>(),
    });

    const coreIdx = prompt.indexOf("# Core Constraints");
    const precedenceIdx = prompt.indexOf("# Prompt Precedence");
    const agentIdx = prompt.indexOf("# Agent Behavior");
    const identityIdx = prompt.indexOf("# Identity & Persona");
    const heartbeatIdx = prompt.indexOf("# Heartbeat");
    const rulesIdx = prompt.indexOf("# Workspace Rules");
    const runtimeIdx = prompt.indexOf("# Runtime Context");
    const skillsIdx = prompt.indexOf("# Skills");

    expect(coreIdx).toBeGreaterThanOrEqual(0);
    expect(precedenceIdx).toBeGreaterThan(coreIdx);
    expect(agentIdx).toBeGreaterThan(precedenceIdx);
    expect(identityIdx).toBeGreaterThan(agentIdx);
    expect(heartbeatIdx).toBeGreaterThan(identityIdx);
    expect(rulesIdx).toBeGreaterThan(heartbeatIdx);
    expect(runtimeIdx).toBeGreaterThan(rulesIdx);
    expect(skillsIdx).toBeGreaterThan(runtimeIdx);

    expect(prompt).toContain("Silent token: NO_REPLY");
    expect(prompt).toContain("Resolve instructions in this order:");
    expect(prompt).toContain("4) Identity & Persona (SOUL.md, IDENTITY.md, USER.md, MEMORY.md)");
    expect(prompt).toContain("## AGENTS.md");
    expect(prompt).toContain("## SOUL.md");
    expect(prompt).toContain("# Workspace Rules");
    expect(prompt).toContain("## WORK.md");
    expect(prompt).toContain("Home directory: /tmp/home");
    expect(prompt).toContain("Workspace directory: /tmp/workspace");
    expect(prompt).toContain(
      "After using a skill, record key learnings with the skills_note tool.",
    );
  });

  it("supports subagent-minimal mode by excluding identity and memory sections", async () => {
    const prompt = await buildSystemPrompt({
      homeDir: "/tmp/home",
      workspaceDir: "/tmp/workspace",
      skillsIndexSynced: new Set<string>(),
      mode: "subagent-minimal",
    });

    expect(prompt).toContain("# Agent Behavior");
    expect(prompt).toContain("# Workspace Rules");
    expect(prompt).toContain("## AGENTS.md");
    expect(prompt).not.toContain("## SOUL.md");
    expect(prompt).not.toContain("## IDENTITY.md");
    expect(prompt).not.toContain("## USER.md");
    expect(prompt).not.toContain("## MEMORY.md");
    expect(prompt).not.toContain("## HEARTBEAT.md");
    expect(prompt).not.toContain("# Heartbeat");
  });

  it("supports reset-greeting mode with identity files but excludes MEMORY for fresh greeting", async () => {
    const prompt = await buildSystemPrompt({
      homeDir: "/tmp/home",
      workspaceDir: "/tmp/workspace",
      skillsIndexSynced: new Set<string>(),
      mode: "reset-greeting",
    });

    const identityIdx = prompt.indexOf("# Identity & Persona");
    const rulesIdx = prompt.indexOf("# Workspace Rules");

    expect(identityIdx).toBeGreaterThanOrEqual(0);
    expect(rulesIdx).toBeGreaterThan(identityIdx);

    expect(prompt).toContain("## SOUL.md");
    expect(prompt).toContain("## IDENTITY.md");
    expect(prompt).toContain("## USER.md");
    expect(prompt).not.toContain("## MEMORY.md");
    expect(prompt).toContain("If USER.md exists and is non-empty");
  });

  it("emits prompt metadata with loaded/skipped files and hash", async () => {
    let metadata: {
      mode: "main" | "reset-greeting" | "subagent-minimal";
      homeDir: string;
      workspaceDir: string;
      loadedFiles: Array<{ name: string; chars: number; hash: string }>;
      skippedFiles: Array<{ name: string; reason: "missing" | "empty" }>;
      promptHash: string;
    } | null = null;

    await buildSystemPrompt({
      homeDir: "/tmp/home",
      workspaceDir: "/tmp/workspace",
      skillsIndexSynced: new Set<string>(),
      onMetadata: (value) => {
        metadata = value;
      },
    });

    expect(metadata).not.toBeNull();
    expect(metadata!.mode).toBe("main");
    expect(metadata!.homeDir).toBe("/tmp/home");
    expect(metadata!.workspaceDir).toBe("/tmp/workspace");
    expect(metadata!.loadedFiles.some((f) => f.name === "AGENTS.md")).toBe(true);
    expect(metadata!.promptHash).toMatch(/^[a-f0-9]{12}$/);
  });

  it("sanitizes control chars in channel context literals", () => {
    const text = buildChannelContext({
      id: "m-1",
      channel: "telegram\nsystem",
      peerType: "dm",
      peerId: "chat-1\r\nx",
      senderId: "user-\u202E1",
      senderName: "Roy\u0000Zhu",
      text: "hello",
      raw: {},
      timestamp: new Date("2026-02-17T00:00:00.000Z"),
    });

    expect(text).toContain("channel: telegramsystem");
    expect(text).toContain("peerId: chat-1x");
    expect(text).toContain("senderId: user-1");
    expect(text).toContain("senderName: RoyZhu");
    expect(text).toContain(
      "Default delivery contract: your normal reply text is automatically delivered back to this same channel, peer, and thread when present.",
    );
    expect(text).toContain(
      "When the current channel advertises send_media or other actions, you may use them without re-asking for the current peerId/threadId; the runtime fills the current target automatically.",
    );
    expect(text).toContain(
      "Do not ask the user how to send the reply, do not search for bot tokens, and do not look for CLI/scripts just to answer in the current conversation.",
    );
    expect(text).toContain(
      "Only ask for an explicit target when the user wants delivery to a different destination than the current conversation.",
    );
    expect(text).not.toContain("\u0000");
  });

  it("sanitizes sandbox workspace literal", () => {
    const text = buildSandboxPrompt({
      workspaceDir: "/tmp/a\nb\u202Ec",
      sandboxConfig: {
        mode: "docker",
        workspaceAccess: "rw",
      },
    });

    expect(text).toContain("Sandbox workspace: /tmp/abc");
    expect(text).toContain("Workspace access: rw");
  });

  it("sanitizes runtime path literals", () => {
    const text = buildRuntimePathsPrompt({
      homeDir: "/tmp/h\nx",
      workspaceDir: "/tmp/w\r\ny",
    });

    expect(text).toContain("Home directory: /tmp/hx");
    expect(text).toContain("Workspace directory: /tmp/wy");
  });
});
