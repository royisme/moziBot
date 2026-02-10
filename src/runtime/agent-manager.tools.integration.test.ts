import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearMemoryManagerCache } from "../memory";
import { AgentManager } from "./agent-manager";
import { ModelRegistry } from "./model-registry";
import { ProviderRegistry } from "./provider-registry";
import { SessionStore } from "./session-store";

const MODEL_REF = "openai/gpt-4o";

describe("AgentManager tools", () => {
  let baseDir: string;
  let homeDir: string;
  let workspaceDir: string;

  beforeEach(async () => {
    baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "mozi-tools-"));
    homeDir = path.join(baseDir, "home");
    workspaceDir = path.join(baseDir, "workspace");
    await fs.mkdir(homeDir, { recursive: true });
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.writeFile(path.join(homeDir, "MEMORY.md"), "# Memory\n\nAlpha note\n", "utf-8");
  });

  afterEach(async () => {
    clearMemoryManagerCache();
    await fs.rm(baseDir, { recursive: true, force: true });
  });

  it("includes memory tools by default", async () => {
    const config = {
      paths: { baseDir, sessions: path.join(baseDir, "sessions") },
      models: {
        providers: {
          openai: {
            api: "openai-responses",
            apiKey: "test",
            models: [{ id: "gpt-4o" }],
          },
        },
      },
      agents: {
        defaults: { model: MODEL_REF },
        mozi: { main: true, home: homeDir, workspace: workspaceDir },
      },
    };

    const manager = new AgentManager({
      config,
      modelRegistry: new ModelRegistry(config),
      providerRegistry: new ProviderRegistry(config),
      sessions: new SessionStore(config),
    });

    const { agent } = await manager.getAgent("mozi:telegram:dm:user1", "mozi");
    const toolNames = (agent.state.tools as Array<{ name: string }>).map((t) => t.name);
    expect(toolNames).toContain("memory_search");
    expect(toolNames).toContain("memory_get");
  });

  it("includes pi coding tools by default", async () => {
    const config = {
      paths: { baseDir, sessions: path.join(baseDir, "sessions") },
      models: {
        providers: {
          openai: {
            api: "openai-responses",
            apiKey: "test",
            models: [{ id: "gpt-4o" }],
          },
        },
      },
      agents: {
        defaults: { model: MODEL_REF },
        mozi: { main: true, home: homeDir, workspace: workspaceDir },
      },
    };

    const manager = new AgentManager({
      config,
      modelRegistry: new ModelRegistry(config),
      providerRegistry: new ProviderRegistry(config),
      sessions: new SessionStore(config),
    });

    const { agent } = await manager.getAgent("mozi:telegram:dm:user1", "mozi");
    const toolNames = (agent.state.tools as Array<{ name: string }>).map((t) => t.name);
    expect(toolNames).toContain("read");
    expect(toolNames).toContain("edit");
    expect(toolNames).toContain("write");
    expect(toolNames).toContain("grep");
    expect(toolNames).toContain("find");
    expect(toolNames).toContain("ls");
  });

  it("executes memory tools through runtime wiring", async () => {
    const config = {
      paths: { baseDir, sessions: path.join(baseDir, "sessions") },
      models: {
        providers: {
          openai: {
            api: "openai-responses",
            apiKey: "test",
            models: [{ id: "gpt-4o" }],
          },
        },
      },
      agents: {
        defaults: { model: MODEL_REF },
        mozi: { main: true, home: homeDir, workspace: workspaceDir },
      },
    };

    const manager = new AgentManager({
      config,
      modelRegistry: new ModelRegistry(config),
      providerRegistry: new ProviderRegistry(config),
      sessions: new SessionStore(config),
    });

    const { agent } = await manager.getAgent("mozi:telegram:dm:user1", "mozi");
    const tools = agent.state.tools as Array<{
      name: string;
      execute: (id: string, args: unknown) => Promise<{ content: Array<{ text?: string }> }>;
    }>;
    const memorySearchTool = tools.find((tool) => tool.name === "memory_search");
    const memoryGetTool = tools.find((tool) => tool.name === "memory_get");

    expect(memorySearchTool).toBeDefined();
    expect(memoryGetTool).toBeDefined();
    if (!memorySearchTool || !memoryGetTool) {
      return;
    }

    const searchResult = await memorySearchTool.execute("tool-1", { query: "Alpha" });
    const searchText = searchResult.content[0]?.text || "[]";
    const searchPayload = JSON.parse(searchText) as Array<{ path: string }>;
    expect(searchPayload.length).toBeGreaterThan(0);
    expect(searchPayload[0].path).toBe("MEMORY.md");

    const getResult = await memoryGetTool.execute("tool-2", {
      path: "MEMORY.md",
      from: 1,
      lines: 2,
    });
    const getText = getResult.content[0]?.text || "{}";
    const getPayload = JSON.parse(getText) as { text?: string };
    expect(getPayload.text).toContain("Memory");
  });

  it("keeps exec even when tool allowlist is empty", async () => {
    const config = {
      paths: { baseDir, sessions: path.join(baseDir, "sessions") },
      models: {
        providers: {
          openai: {
            api: "openai-responses",
            apiKey: "test",
            models: [{ id: "gpt-4o" }],
          },
        },
      },
      agents: {
        defaults: { model: MODEL_REF, tools: [] },
        mozi: { main: true, home: homeDir, workspace: workspaceDir },
      },
    };

    const manager = new AgentManager({
      config,
      modelRegistry: new ModelRegistry(config),
      providerRegistry: new ProviderRegistry(config),
      sessions: new SessionStore(config),
    });

    const { agent } = await manager.getAgent("mozi:telegram:dm:user1", "mozi");
    const toolNames = (agent.state.tools as Array<{ name: string }>).map((t) => t.name);
    expect(toolNames).toEqual(["exec"]);
  });

  it("keeps exec when agent-specific tool list omits it", async () => {
    const config = {
      paths: { baseDir, sessions: path.join(baseDir, "sessions") },
      models: {
        providers: {
          openai: {
            api: "openai-responses",
            apiKey: "test",
            models: [{ id: "gpt-4o" }],
          },
        },
      },
      agents: {
        defaults: { model: MODEL_REF },
        mozi: {
          main: true,
          home: homeDir,
          workspace: workspaceDir,
          tools: ["memory_search"],
        },
      },
    };

    const manager = new AgentManager({
      config,
      modelRegistry: new ModelRegistry(config),
      providerRegistry: new ProviderRegistry(config),
      sessions: new SessionStore(config),
    });

    const { agent } = await manager.getAgent("mozi:telegram:dm:user1", "mozi");
    const toolNames = (agent.state.tools as Array<{ name: string }>).map((t) => t.name);
    expect(toolNames).toContain("memory_search");
    expect(toolNames).toContain("exec");
  });

  it("resolves default agent by explicit main=true", () => {
    const config = {
      paths: { baseDir, sessions: path.join(baseDir, "sessions") },
      models: {
        providers: {
          openai: {
            api: "openai-responses",
            apiKey: "test",
            models: [{ id: "gpt-4o" }],
          },
        },
      },
      agents: {
        defaults: { model: MODEL_REF },
        writer: { home: homeDir, workspace: workspaceDir },
        reviewer: { main: true, home: homeDir, workspace: workspaceDir },
      },
    };

    const manager = new AgentManager({
      config,
      modelRegistry: new ModelRegistry(config),
      providerRegistry: new ProviderRegistry(config),
      sessions: new SessionStore(config),
    });

    expect(manager.resolveDefaultAgentId()).toBe("reviewer");
  });

  it("falls back to the first configured agent when no main is declared", () => {
    const config = {
      paths: { baseDir, sessions: path.join(baseDir, "sessions") },
      models: {
        providers: {
          openai: {
            api: "openai-responses",
            apiKey: "test",
            models: [{ id: "gpt-4o" }],
          },
        },
      },
      agents: {
        defaults: { model: MODEL_REF },
        first: { home: homeDir, workspace: workspaceDir },
        second: { home: homeDir, workspace: workspaceDir },
      },
    };

    const manager = new AgentManager({
      config,
      modelRegistry: new ModelRegistry(config),
      providerRegistry: new ProviderRegistry(config),
      sessions: new SessionStore(config),
    });

    expect(manager.resolveDefaultAgentId()).toBe("first");
  });

  it("probes only containerized sandboxes and reports diagnostics", async () => {
    const config = {
      paths: { baseDir, sessions: path.join(baseDir, "sessions") },
      models: {
        providers: {
          openai: {
            api: "openai-responses",
            apiKey: "test",
            models: [{ id: "gpt-4o" }],
          },
        },
      },
      agents: {
        defaults: { model: MODEL_REF },
        mozi: {
          main: true,
          home: homeDir,
          workspace: workspaceDir,
          sandbox: { mode: "off" },
        },
        dockerAgent: {
          main: false,
          home: homeDir,
          workspace: workspaceDir,
          sandbox: { mode: "docker" },
        },
      },
    };

    const manager = new AgentManager({
      config,
      modelRegistry: new ModelRegistry(config),
      providerRegistry: new ProviderRegistry(config),
      sessions: new SessionStore(config),
    });

    const reports = await manager.probeSandboxes();
    expect(reports.length).toBe(1);
    expect(reports[0]?.agentId).toBe("dockerAgent");
    expect(reports[0]?.result.ok).toBe(false);
    expect(reports[0]?.result.message).toContain("missing docker.image");
  });

  it("routes media input to configured vision model", async () => {
    const config = {
      paths: { baseDir, sessions: path.join(baseDir, "sessions") },
      models: {
        providers: {
          openai: {
            api: "openai-responses",
            apiKey: "test",
            models: [
              { id: "gpt-4o", input: ["text"] },
              { id: "gpt-4o-vision", input: ["text", "image"] },
            ],
          },
        },
      },
      agents: {
        defaults: {
          model: {
            primary: "openai/gpt-4o",
            vision: "openai/gpt-4o-vision",
          },
        },
        mozi: { main: true, home: homeDir, workspace: workspaceDir },
      },
    };

    const manager = new AgentManager({
      config,
      modelRegistry: new ModelRegistry(config),
      providerRegistry: new ProviderRegistry(config),
      sessions: new SessionStore(config),
    });

    const result = await manager.ensureSessionModelForInput({
      sessionKey: "mozi:telegram:dm:user-vision",
      agentId: "mozi",
      input: "image",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.modelRef).toBe("openai/gpt-4o-vision");
    expect(result.switched).toBe(true);
  });

  it("returns image candidates when no vision model can be routed", async () => {
    const config = {
      paths: { baseDir, sessions: path.join(baseDir, "sessions") },
      models: {
        providers: {
          openai: {
            api: "openai-responses",
            apiKey: "test",
            models: [
              { id: "gpt-4o", input: ["text"] },
              { id: "gpt-4o-vision", input: ["text", "image"] },
            ],
          },
        },
      },
      agents: {
        defaults: {
          model: {
            primary: "openai/gpt-4o",
            vision: "openai/unknown-vision",
          },
        },
        mozi: { main: true, home: homeDir, workspace: workspaceDir },
      },
    };

    const manager = new AgentManager({
      config,
      modelRegistry: new ModelRegistry(config),
      providerRegistry: new ProviderRegistry(config),
      sessions: new SessionStore(config),
    });

    const result = await manager.ensureSessionModelForInput({
      sessionKey: "mozi:telegram:dm:user-no-vision",
      agentId: "mozi",
      input: "image",
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.candidates).toContain("openai/gpt-4o-vision");
  });

  it("control_model_defaults_precedence", () => {
    const config = {
      paths: { baseDir, sessions: path.join(baseDir, "sessions") },
      models: {
        providers: {
          openai: {
            api: "openai-responses",
            apiKey: "test",
            models: [{ id: "gpt-4o" }, { id: "gpt-4o-mini" }],
          },
        },
      },
      agents: {
        defaults: {
          model: "openai/gpt-4o",
          lifecycle: {
            control: {
              model: "openai/gpt-4o-mini",
            },
          },
        },
        mozi: { main: true, home: homeDir, workspace: workspaceDir },
      },
    };

    const manager = new AgentManager({
      config,
      modelRegistry: new ModelRegistry(config),
      providerRegistry: new ProviderRegistry(config),
      sessions: new SessionStore(config),
    });

    const resolved = manager.resolveLifecycleControlModel({
      sessionKey: "mozi:telegram:dm:user-control-defaults",
      agentId: "mozi",
    });
    expect(resolved.modelRef).toBe("openai/gpt-4o-mini");
    expect(resolved.source).toBe("defaults");
  });

  it("control_model_session_override_precedence", () => {
    const config = {
      paths: { baseDir, sessions: path.join(baseDir, "sessions") },
      models: {
        providers: {
          openai: {
            api: "openai-responses",
            apiKey: "test",
            models: [{ id: "gpt-4o" }, { id: "gpt-4o-mini" }, { id: "gpt-4.1-mini" }],
          },
        },
      },
      agents: {
        defaults: {
          model: "openai/gpt-4o",
          lifecycle: {
            control: {
              model: "openai/gpt-4o-mini",
            },
          },
        },
        mozi: { main: true, home: homeDir, workspace: workspaceDir },
      },
    };

    const sessions = new SessionStore(config);
    sessions.getOrCreate("mozi:telegram:dm:user-control-session", "mozi");
    sessions.update("mozi:telegram:dm:user-control-session", {
      metadata: {
        lifecycle: {
          controlModel: "openai/gpt-4.1-mini",
        },
      },
    });

    const manager = new AgentManager({
      config,
      modelRegistry: new ModelRegistry(config),
      providerRegistry: new ProviderRegistry(config),
      sessions,
    });

    const resolved = manager.resolveLifecycleControlModel({
      sessionKey: "mozi:telegram:dm:user-control-session",
      agentId: "mozi",
    });
    expect(resolved.modelRef).toBe("openai/gpt-4.1-mini");
    expect(resolved.source).toBe("session");
  });

  it("control_model_fallback_deterministic", () => {
    const config = {
      paths: { baseDir, sessions: path.join(baseDir, "sessions") },
      models: {
        providers: {
          openai: {
            api: "openai-responses",
            apiKey: "test",
            models: [{ id: "gpt-4o" }, { id: "gpt-4o-mini" }],
          },
        },
      },
      agents: {
        defaults: {
          model: "openai/gpt-4o",
          lifecycle: {
            control: {
              model: "openai/not-installed",
              fallback: ["openai/not-installed-2", "openai/gpt-4o-mini"],
            },
          },
        },
        mozi: {
          main: true,
          home: homeDir,
          workspace: workspaceDir,
          lifecycle: {
            control: {
              model: "openai/not-installed-3",
              fallback: ["openai/not-installed-9", "openai/gpt-4o-mini"],
            },
          },
        },
      },
    };

    const manager = new AgentManager({
      config,
      modelRegistry: new ModelRegistry(config),
      providerRegistry: new ProviderRegistry(config),
      sessions: new SessionStore(config),
    });

    const a = manager.resolveLifecycleControlModel({
      sessionKey: "mozi:telegram:dm:user-control-fallback",
      agentId: "mozi",
    });
    const b = manager.resolveLifecycleControlModel({
      sessionKey: "mozi:telegram:dm:user-control-fallback",
      agentId: "mozi",
    });

    expect(a.modelRef).toBe("openai/gpt-4o-mini");
    expect(a.source).toBe("fallback");
    expect(b.modelRef).toBe("openai/gpt-4o-mini");
    expect(b.source).toBe("fallback");
  });

  it("resets session model lock to defaults primary", async () => {
    const config = {
      paths: { baseDir, sessions: path.join(baseDir, "sessions") },
      models: {
        providers: {
          openai: {
            api: "openai-responses",
            apiKey: "test",
            models: [{ id: "gpt-4o" }, { id: "gpt-4o-mini" }],
          },
        },
      },
      agents: {
        defaults: { model: "openai/gpt-4o" },
        mozi: { main: true, home: homeDir, workspace: workspaceDir },
      },
    };

    const manager = new AgentManager({
      config,
      modelRegistry: new ModelRegistry(config),
      providerRegistry: new ProviderRegistry(config),
      sessions: new SessionStore(config),
    });

    const sessionKey = "mozi:tui:dm:local";
    await manager.getAgent(sessionKey, "mozi");
    await manager.setSessionModel(sessionKey, "openai/gpt-4o-mini");
    const locked = await manager.getAgent(sessionKey, "mozi");
    expect(locked.modelRef).toBe("openai/gpt-4o-mini");

    manager.resetSession(sessionKey);
    const reset = await manager.getAgent(sessionKey, "mozi");
    expect(reset.modelRef).toBe("openai/gpt-4o");
  });

  it("resets persisted session model lock even when session cache is cold", async () => {
    const config = {
      paths: { baseDir, sessions: path.join(baseDir, "sessions") },
      models: {
        providers: {
          openai: {
            api: "openai-responses",
            apiKey: "test",
            models: [{ id: "gpt-4o" }, { id: "gpt-4o-mini" }],
          },
        },
      },
      agents: {
        defaults: { model: "openai/gpt-4o" },
        mozi: { main: true, home: homeDir, workspace: workspaceDir },
      },
    };

    const sessionKey = "mozi:tui:dm:cold-cache";

    const managerA = new AgentManager({
      config,
      modelRegistry: new ModelRegistry(config),
      providerRegistry: new ProviderRegistry(config),
      sessions: new SessionStore(config),
    });
    await managerA.getAgent(sessionKey, "mozi");
    await managerA.setSessionModel(sessionKey, "openai/gpt-4o-mini");
    const locked = await managerA.getAgent(sessionKey, "mozi");
    expect(locked.modelRef).toBe("openai/gpt-4o-mini");

    const managerB = new AgentManager({
      config,
      modelRegistry: new ModelRegistry(config),
      providerRegistry: new ProviderRegistry(config),
      sessions: new SessionStore(config),
    });
    managerB.resetSession(sessionKey, "mozi");
    const reset = await managerB.getAgent(sessionKey, "mozi");
    expect(reset.modelRef).toBe("openai/gpt-4o");
  });

  it("sanitizes tool schema only for Gemini-compatible models", async () => {
    const config = {
      paths: { baseDir, sessions: path.join(baseDir, "sessions") },
      models: {
        providers: {
          google: {
            api: "google-generative-ai",
            apiKey: "test",
            models: [{ id: "gemini-2.0-flash" }],
          },
          openai: {
            api: "openai-responses",
            apiKey: "test",
            models: [{ id: "gpt-4o" }],
          },
        },
      },
      agents: {
        defaults: { model: "google/gemini-2.0-flash" },
        mozi: { main: true, home: homeDir, workspace: workspaceDir },
      },
    };

    const manager = new AgentManager({
      config,
      modelRegistry: new ModelRegistry(config),
      providerRegistry: new ProviderRegistry(config),
      sessions: new SessionStore(config),
    });

    const gemini = await manager.getAgent("mozi:telegram:dm:gemini-user", "mozi");
    const geminiExec = (
      gemini.agent.state.tools as Array<{ name: string; parameters: unknown }>
    ).find((tool) => tool.name === "exec");
    expect(geminiExec).toBeDefined();
    if (!geminiExec) {
      return;
    }
    const geminiEnv = (
      (geminiExec.parameters as Record<string, unknown>).properties as Record<string, unknown>
    ).env as Record<string, unknown>;
    expect(geminiEnv.patternProperties).toBeUndefined();
    expect(geminiEnv.additionalProperties).toBeDefined();

    manager.resetSession("mozi:telegram:dm:gemini-user", "mozi");
    await manager.setSessionModel("mozi:telegram:dm:gemini-user", "openai/gpt-4o");
    const openai = await manager.getAgent("mozi:telegram:dm:gemini-user", "mozi");
    const openaiExec = (
      openai.agent.state.tools as Array<{ name: string; parameters: unknown }>
    ).find((tool) => tool.name === "exec");
    expect(openaiExec).toBeDefined();
    if (!openaiExec) {
      return;
    }
    const openaiEnv = (
      (openaiExec.parameters as Record<string, unknown>).properties as Record<string, unknown>
    ).env as Record<string, unknown>;
    expect(openaiEnv.patternProperties).toBeDefined();
  });

  it("sanitizes tool schema for proxy providers hosting Gemini models", async () => {
    const config = {
      paths: { baseDir, sessions: path.join(baseDir, "sessions") },
      models: {
        providers: {
          quotio: {
            api: "openai-responses",
            apiKey: "test",
            baseUrl: "https://api.quotio.ai/v1",
            models: [{ id: "gemini-3-pro-preview" }],
          },
          openai: {
            api: "openai-responses",
            apiKey: "test",
            models: [{ id: "gpt-4o" }],
          },
        },
      },
      agents: {
        defaults: { model: "quotio/gemini-3-pro-preview" },
        mozi: { main: true, home: homeDir, workspace: workspaceDir },
      },
    };

    const manager = new AgentManager({
      config,
      modelRegistry: new ModelRegistry(config),
      providerRegistry: new ProviderRegistry(config),
      sessions: new SessionStore(config),
    });

    const geminiProxy = await manager.getAgent("mozi:telegram:dm:gemini-proxy-user", "mozi");
    const geminiProxyExec = (
      geminiProxy.agent.state.tools as Array<{ name: string; parameters: unknown }>
    ).find((tool) => tool.name === "exec");
    expect(geminiProxyExec).toBeDefined();
    if (!geminiProxyExec) {
      return;
    }
    const geminiProxyEnv = (
      (geminiProxyExec.parameters as Record<string, unknown>).properties as Record<string, unknown>
    ).env as Record<string, unknown>;
    expect(geminiProxyEnv.patternProperties).toBeUndefined();
    expect(geminiProxyEnv.additionalProperties).toBeDefined();

    manager.resetSession("mozi:telegram:dm:gemini-proxy-user", "mozi");
    await manager.setSessionModel("mozi:telegram:dm:gemini-proxy-user", "openai/gpt-4o");
    const openai = await manager.getAgent("mozi:telegram:dm:gemini-proxy-user", "mozi");
    const openaiExec = (
      openai.agent.state.tools as Array<{ name: string; parameters: unknown }>
    ).find((tool) => tool.name === "exec");
    expect(openaiExec).toBeDefined();
    if (!openaiExec) {
      return;
    }
    const openaiEnv = (
      (openaiExec.parameters as Record<string, unknown>).properties as Record<string, unknown>
    ).env as Record<string, unknown>;
    expect(openaiEnv.patternProperties).toBeDefined();
  });

  it("respects runtime.sanitizeToolSchema=false for Gemini models", async () => {
    const config = {
      paths: { baseDir, sessions: path.join(baseDir, "sessions") },
      models: {
        providers: {
          google: {
            api: "google-generative-ai",
            apiKey: "test",
            models: [{ id: "gemini-2.0-flash" }],
          },
        },
      },
      runtime: {
        sanitizeToolSchema: false,
      },
      agents: {
        defaults: { model: "google/gemini-2.0-flash" },
        mozi: { main: true, home: homeDir, workspace: workspaceDir },
      },
    };

    const manager = new AgentManager({
      config,
      modelRegistry: new ModelRegistry(config),
      providerRegistry: new ProviderRegistry(config),
      sessions: new SessionStore(config),
    });

    const { agent } = await manager.getAgent("mozi:telegram:dm:gemini-raw", "mozi");
    const exec = (agent.state.tools as Array<{ name: string; parameters: unknown }>).find(
      (tool) => tool.name === "exec",
    );
    expect(exec).toBeDefined();
    if (!exec) {
      return;
    }
    const env = ((exec.parameters as Record<string, unknown>).properties as Record<string, unknown>)
      .env as Record<string, unknown>;
    expect(env.patternProperties).toBeDefined();
  });

  it("invalidates cached agent when switching between sanitization-incompatible models", async () => {
    const config = {
      paths: { baseDir, sessions: path.join(baseDir, "sessions") },
      models: {
        providers: {
          openai: {
            api: "openai-responses",
            apiKey: "test",
            models: [{ id: "gpt-4o" }],
          },
          quotio: {
            api: "openai-responses",
            apiKey: "test",
            baseUrl: "https://api.quotio.ai/v1",
            models: [{ id: "gemini-3-flash-preview" }],
          },
        },
      },
      agents: {
        defaults: { model: "openai/gpt-4o" },
        mozi: { main: true, home: homeDir, workspace: workspaceDir },
      },
    };

    const manager = new AgentManager({
      config,
      modelRegistry: new ModelRegistry(config),
      providerRegistry: new ProviderRegistry(config),
      sessions: new SessionStore(config),
    });

    const sessionKey = "mozi:telegram:dm:switch-test";
    const openai = await manager.getAgent(sessionKey, "mozi");
    const openaiExec = (
      openai.agent.state.tools as Array<{ name: string; parameters: unknown }>
    ).find((tool) => tool.name === "exec");
    expect(openaiExec).toBeDefined();
    if (!openaiExec) {
      return;
    }
    const openaiEnv = (
      (openaiExec.parameters as Record<string, unknown>).properties as Record<string, unknown>
    ).env as Record<string, unknown>;
    expect(openaiEnv.patternProperties).toBeDefined();

    await manager.setSessionModel(sessionKey, "quotio/gemini-3-flash-preview");
    const gemini = await manager.getAgent(sessionKey, "mozi");
    const geminiExec = (
      gemini.agent.state.tools as Array<{ name: string; parameters: unknown }>
    ).find((tool) => tool.name === "exec");
    expect(geminiExec).toBeDefined();
    if (!geminiExec) {
      return;
    }
    const geminiEnv = (
      (geminiExec.parameters as Record<string, unknown>).properties as Record<string, unknown>
    ).env as Record<string, unknown>;
    expect(geminiEnv.patternProperties).toBeUndefined();
    expect(geminiEnv.additionalProperties).toBeDefined();

    await manager.setSessionModel(sessionKey, "openai/gpt-4o");
    const openaiAgain = await manager.getAgent(sessionKey, "mozi");
    const openaiAgainExec = (
      openaiAgain.agent.state.tools as Array<{ name: string; parameters: unknown }>
    ).find((tool) => tool.name === "exec");
    expect(openaiAgainExec).toBeDefined();
    if (!openaiAgainExec) {
      return;
    }
    const openaiAgainEnv = (
      (openaiAgainExec.parameters as Record<string, unknown>).properties as Record<string, unknown>
    ).env as Record<string, unknown>;
    expect(openaiAgainEnv.patternProperties).toBeDefined();
  });
});
