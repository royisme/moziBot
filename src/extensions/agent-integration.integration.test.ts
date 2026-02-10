import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearMemoryManagerCache } from "../memory";
import { AgentManager } from "../runtime/agent-manager";
import { ModelRegistry } from "../runtime/model-registry";
import { ProviderRegistry } from "../runtime/provider-registry";
import { SessionStore } from "../runtime/session-store";

const MODEL_REF = "openai/gpt-4o";

describe("AgentManager extension tools integration", () => {
  let baseDir: string;
  let homeDir: string;
  let workspaceDir: string;

  beforeEach(async () => {
    baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "mozi-ext-"));
    homeDir = path.join(baseDir, "home");
    workspaceDir = path.join(baseDir, "workspace");
    await fs.mkdir(homeDir, { recursive: true });
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.writeFile(path.join(homeDir, "MEMORY.md"), "# Memory\n", "utf-8");
  });

  afterEach(async () => {
    clearMemoryManagerCache();
    await fs.rm(baseDir, { recursive: true, force: true });
  });

  it("includes web_search tool when extension is enabled and tool is in allowlist", async () => {
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
        defaults: {
          model: MODEL_REF,
          tools: ["read", "edit", "exec", "web_search"],
        },
        mozi: { main: true, home: homeDir, workspace: workspaceDir },
      },
      extensions: {
        enabled: true,
        entries: {
          "web-tavily": {
            enabled: true,
            config: { apiKeyEnv: "TAVILY_API_KEY" },
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

    const { agent } = await manager.getAgent("mozi:test:dm:ext-test", "mozi");
    const toolNames = (agent.state.tools as Array<{ name: string }>).map((t) => t.name);
    expect(toolNames).toContain("web_search");
  });

  it("excludes web_search tool when tool is not in allowlist", async () => {
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
        defaults: {
          model: MODEL_REF,
          tools: ["read", "edit", "exec"],
        },
        mozi: { main: true, home: homeDir, workspace: workspaceDir },
      },
      extensions: {
        enabled: true,
        entries: {
          "web-tavily": {
            enabled: true,
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

    const { agent } = await manager.getAgent("mozi:test:dm:no-web", "mozi");
    const toolNames = (agent.state.tools as Array<{ name: string }>).map((t) => t.name);
    expect(toolNames).not.toContain("web_search");
  });

  it("excludes web_search when extension is disabled", async () => {
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
        defaults: {
          model: MODEL_REF,
          tools: ["read", "exec", "web_search"],
        },
        mozi: { main: true, home: homeDir, workspace: workspaceDir },
      },
      extensions: {
        enabled: true,
        entries: {
          "web-tavily": {
            enabled: false,
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

    const { agent } = await manager.getAgent("mozi:test:dm:disabled-ext", "mozi");
    const toolNames = (agent.state.tools as Array<{ name: string }>).map((t) => t.name);
    expect(toolNames).not.toContain("web_search");
  });

  it("excludes web_search when extensions subsystem is disabled", async () => {
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
        defaults: {
          model: MODEL_REF,
          tools: ["read", "exec", "web_search"],
        },
        mozi: { main: true, home: homeDir, workspace: workspaceDir },
      },
      extensions: {
        enabled: false,
        entries: {
          "web-tavily": { enabled: true },
        },
      },
    };

    const manager = new AgentManager({
      config,
      modelRegistry: new ModelRegistry(config),
      providerRegistry: new ProviderRegistry(config),
      sessions: new SessionStore(config),
    });

    const { agent } = await manager.getAgent("mozi:test:dm:sys-disabled", "mozi");
    const toolNames = (agent.state.tools as Array<{ name: string }>).map((t) => t.name);
    expect(toolNames).not.toContain("web_search");
  });

  it("web_search tool returns error when API key is not set", async () => {
    // Ensure the env var is not set for this test
    const savedKey = process.env.TAVILY_API_KEY;
    delete process.env.TAVILY_API_KEY;

    try {
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
          defaults: {
            model: MODEL_REF,
            tools: ["exec", "web_search"],
          },
          mozi: { main: true, home: homeDir, workspace: workspaceDir },
        },
        extensions: {
          enabled: true,
          entries: {
            "web-tavily": {
              enabled: true,
              config: { apiKeyEnv: "TAVILY_API_KEY" },
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

      const { agent } = await manager.getAgent("mozi:test:dm:no-key", "mozi");
      const tools = agent.state.tools as Array<{
        name: string;
        execute: (id: string, args: unknown) => Promise<{ content: Array<{ text?: string }> }>;
      }>;
      const webSearch = tools.find((t) => t.name === "web_search");
      expect(webSearch).toBeDefined();

      if (!webSearch) {
        return;
      }

      const result = await webSearch.execute("call-1", {
        query: "Who is Leo Messi?",
      });
      const text = result.content[0]?.text || "";
      expect(text).toContain("TAVILY_API_KEY");
      expect(text.toLowerCase()).toContain("not found");
      expect(text).toContain("mozi auth set tavily");
    } finally {
      if (savedKey !== undefined) {
        process.env.TAVILY_API_KEY = savedKey;
      }
    }
  });

  it("extension registry is accessible from agent manager", () => {
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
      extensions: {
        enabled: true,
        entries: {
          "web-tavily": { enabled: true },
        },
      },
    };

    const manager = new AgentManager({
      config,
      modelRegistry: new ModelRegistry(config),
      providerRegistry: new ProviderRegistry(config),
      sessions: new SessionStore(config),
    });

    const registry = manager.getExtensionRegistry();
    expect(registry).toBeDefined();
    const ext = registry.get("web-tavily");
    expect(ext).toBeDefined();
    expect(ext?.manifest.id).toBe("web-tavily");
  });
});
