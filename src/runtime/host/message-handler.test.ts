import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MoziConfig } from "../../config";
import type { ChannelPlugin } from "../adapters/channels/plugin";
import type { InboundMessage } from "../adapters/channels/types";
import { MessageHandler } from "./message-handler";

const ingestInboundMessageMock = vi.fn((..._args: unknown[]) => null);
const preprocessInboundMessageMock = vi.fn<
  (..._args: unknown[]) => Promise<{ transcript: string | null; hasAudioTranscript: boolean }>
>(async (..._args: unknown[]) => ({ transcript: null, hasAudioTranscript: false }));
const fsReadFileMock = vi.fn<(..._args: unknown[]) => Promise<string>>(
  async (..._args: unknown[]) => "",
);
const fsWriteFileMock = vi.fn<(..._args: unknown[]) => Promise<void>>(
  async (..._args: unknown[]) => {},
);

vi.mock("../../multimodal/ingest", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../multimodal/ingest")>();
  return {
    ...actual,
    ingestInboundMessage: (...args: Parameters<typeof actual.ingestInboundMessage>) =>
      ingestInboundMessageMock(...args),
  };
});

vi.mock("../media-understanding/preprocess", () => ({
  InboundMediaPreprocessor: class {
    preprocessInboundMessage = (...args: unknown[]) => preprocessInboundMessageMock(...args);

    updateConfig() {}
  },
}));

vi.mock("node:fs/promises", () => ({
  default: {
    readFile: (...args: unknown[]) => fsReadFileMock(...args),
    writeFile: (...args: unknown[]) => fsWriteFileMock(...args),
  },
  readFile: (...args: unknown[]) => fsReadFileMock(...args),
  writeFile: (...args: unknown[]) => fsWriteFileMock(...args),
}));

function createConfig(): MoziConfig {
  return {
    models: {
      providers: {
        quotio: {
          api: "openai-responses",
          baseUrl: "https://example.invalid/v1",
          apiKey: "test-key",
          models: [{ id: "gemini-3-flash-preview" }],
        },
      },
    },
    agents: {
      mozi: {
        model: "quotio/gemini-3-flash-preview",
      },
    },
  };
}

function createConfigWithTemporalLifecycle(overrides?: {
  enabled?: boolean;
  activeWindowHours?: number;
  dayBoundaryRollover?: boolean;
}): MoziConfig {
  return {
    ...createConfig(),
    agents: {
      defaults: {
        lifecycle: {
          temporal: {
            enabled: overrides?.enabled ?? true,
            activeWindowHours: overrides?.activeWindowHours ?? 12,
            dayBoundaryRollover: overrides?.dayBoundaryRollover ?? true,
          },
        },
      },
      mozi: {
        model: "quotio/gemini-3-flash-preview",
      },
    },
  };
}

function createConfigWithSemanticLifecycle(overrides?: {
  enabled?: boolean;
  threshold?: number;
  debounceSeconds?: number;
  reversible?: boolean;
}): MoziConfig {
  return {
    ...createConfig(),
    models: {
      providers: {
        quotio: {
          api: "openai-responses",
          baseUrl: "https://example.invalid/v1",
          apiKey: "test-key",
          models: [{ id: "gemini-3-flash-preview" }, { id: "control-mini" }],
        },
      },
    },
    agents: {
      defaults: {
        lifecycle: {
          semantic: {
            enabled: overrides?.enabled ?? true,
            threshold: overrides?.threshold ?? 0.8,
            debounceSeconds: overrides?.debounceSeconds ?? 60,
            reversible: overrides?.reversible ?? true,
          },
          control: {
            model: "quotio/control-mini",
          },
        },
      },
      mozi: {
        model: "quotio/gemini-3-flash-preview",
      },
    },
  };
}

function createMessage(text: string): InboundMessage {
  return {
    id: "m-1",
    channel: "telegram",
    peerId: "chat-1",
    peerType: "dm",
    senderId: "u-1",
    senderName: "tester",
    text,
    timestamp: new Date(),
    raw: {},
  };
}

function createMediaMessage(text: string): InboundMessage {
  return {
    ...createMessage(text),
    media: [
      {
        type: "photo",
        url: "https://example.invalid/image.png",
      },
    ],
  };
}

function createAudioMessage(text: string): InboundMessage {
  return {
    ...createMessage(text),
    media: [
      {
        type: "voice",
        url: "voice-file-1",
        mimeType: "audio/ogg",
      },
    ],
  };
}

describe("MessageHandler commands", () => {
  let handler: MessageHandler;
  let channel: ChannelPlugin;
  let send: ReturnType<typeof vi.fn>;
  let restart: ReturnType<typeof vi.fn>;
  let resetSession: ReturnType<typeof vi.fn>;
  let setSessionModel: ReturnType<typeof vi.fn>;
  let updateSessionMetadata: ReturnType<typeof vi.fn>;
  let ensureSessionModelForInput: ReturnType<typeof vi.fn>;
  let runPromptWithFallback: ReturnType<typeof vi.fn>;
  let editMessageMock: ReturnType<typeof vi.fn>;
  let beginTyping: ReturnType<typeof vi.fn>;
  let stopTyping: ReturnType<typeof vi.fn>;
  let emitPhase: ReturnType<typeof vi.fn>;
  let getSessionMetadata: ReturnType<typeof vi.fn>;
  let resolveConfiguredThinkingLevel: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    send = vi.fn(async () => "out-1");
    restart = vi.fn(async () => {});
    resetSession = vi.fn(() => {});
    setSessionModel = vi.fn(() => {});
    updateSessionMetadata = vi.fn(() => {});
    ensureSessionModelForInput = vi.fn(async () => ({
      ok: true as const,
      modelRef: "quotio/gemini-3-flash-preview",
      switched: false,
    }));
    runPromptWithFallback = vi.fn(async () => {});
    editMessageMock = vi.fn(async () => {});
    stopTyping = vi.fn(async () => {});
    beginTyping = vi.fn(async () => stopTyping);
    emitPhase = vi.fn(async () => {});
    getSessionMetadata = vi.fn(() => undefined);
    resolveConfiguredThinkingLevel = vi.fn(() => "low");
    ingestInboundMessageMock.mockClear();
    preprocessInboundMessageMock.mockClear();
    fsReadFileMock.mockReset();
    fsWriteFileMock.mockReset();
    fsReadFileMock.mockResolvedValue("# HEARTBEAT.md\n");
    fsWriteFileMock.mockResolvedValue();

    channel = {
      id: "telegram",
      name: "Telegram",
      connect: async () => {},
      disconnect: async () => {},
      send,
      editMessage: editMessageMock as unknown as (
        messageId: string,
        peerId: string,
        text: string,
      ) => Promise<void>,
      beginTyping: beginTyping as unknown as (
        peerId: string,
      ) => Promise<(() => Promise<void> | void) | undefined>,
      emitPhase: emitPhase as unknown as (
        peerId: string,
        phase: "idle" | "listening" | "thinking" | "speaking" | "executing" | "error",
      ) => Promise<void>,
      getStatus: () => "connected",
      isConnected: () => true,
      on: () => channel,
      once: () => channel,
      off: () => channel,
      emit: () => true,
      removeAllListeners: () => channel,
    } as unknown as ChannelPlugin;

    handler = new MessageHandler(createConfig(), {
      runtimeControl: {
        getStatus: () => ({ running: true, pid: 123, uptime: 42 }),
        restart: restart as unknown as () => Promise<void>,
      },
    });

    const h = handler as unknown as {
      router: {
        resolve: (
          msg: InboundMessage,
          defaultAgentId: string,
        ) => {
          agentId: string;
          dmScope?: "main" | "per-peer" | "per-channel-peer" | "per-account-channel-peer";
        };
      };
      modelRegistry: {
        get: (ref: string) => unknown;
        list: () => Array<{ provider: string; id: string }>;
        resolve: (ref: string) => { ref: string; spec: unknown } | undefined;
        suggestRefs: (ref: string, limit?: number) => string[];
      };
      agentManager: {
        resolveDefaultAgentId: () => string;
        getAgent: (
          sessionKey: string,
          agentId: string,
          options?: { promptMode?: "main" | "reset-greeting" | "subagent-minimal" },
        ) => Promise<{ agent: { messages: unknown[] }; modelRef: string }>;
        setSessionModel: (
          sessionKey: string,
          modelRef: string,
          options?: { persist?: boolean },
        ) => void;
        clearRuntimeModelOverride: (sessionKey: string) => void;
        ensureSessionModelForInput: (params: {
          sessionKey: string;
          agentId: string;
          input: "text" | "image" | "audio" | "video" | "file";
        }) => Promise<
          | { ok: true; modelRef: string; switched: boolean }
          | { ok: false; modelRef: string; candidates: string[] }
        >;
        resetSession: (sessionKey: string) => void;
        ensureChannelContext: (params: unknown) => Promise<void>;
        updateSessionContext: (sessionKey: string, messages: unknown[]) => void;
        updateSessionMetadata: (sessionKey: string, patch: unknown) => void;
        getSessionMetadata: (sessionKey: string) => Record<string, unknown> | undefined;
        getPromptMetadata: (sessionKey: string) =>
          | {
              mode: "main" | "reset-greeting" | "subagent-minimal";
              homeDir: string;
              workspaceDir: string;
              loadedFiles: Array<{ name: string; chars: number }>;
              skippedFiles: Array<{ name: string; reason: "missing" | "empty" }>;
              promptHash: string;
            }
          | undefined;
        resolveConfiguredThinkingLevel: (
          agentId: string,
        ) => "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | undefined;
        getContextUsage: (sessionKey: string) => unknown;
        getContextBreakdown: (sessionKey: string) => unknown;
        getWorkspaceDir: (agentId: string) => string | undefined;
      };
      runPromptWithFallback: (params: unknown) => Promise<void>;
    };

    h.router = {
      resolve: () => ({ agentId: "mozi", dmScope: "per-channel-peer" }),
    };
    h.modelRegistry = {
      get: (ref: string) => (ref === "quotio/gemini-3-flash-preview" ? {} : undefined),
      list: () => [{ provider: "quotio", id: "gemini-3-flash-preview" }],
      resolve: (ref: string) =>
        ref === "quotio/gemini-3-flash-preview" || ref === "quotio/gemini-3-flash-perview"
          ? { ref: "quotio/gemini-3-flash-preview", spec: {} }
          : undefined,
      suggestRefs: () => ["quotio/gemini-3-flash-preview"],
    };
    h.agentManager = {
      resolveDefaultAgentId: () => "mozi",
      getAgent: (async (
        _sessionKey: string,
        _agentId: string,
        options?: {
          promptMode?: "main" | "reset-greeting" | "subagent-minimal";
        },
      ) => ({
        agent: {
          messages:
            options?.promptMode === "reset-greeting"
              ? [{ role: "assistant", content: "what they want to work on now" }]
              : [],
          prompt: async () => {},
        },
        modelRef: "quotio/gemini-3-flash-preview",
      })) as unknown as (
        sessionKey: string,
        agentId: string,
        options?: { promptMode?: "main" | "reset-greeting" | "subagent-minimal" },
      ) => Promise<{
        agent: { messages: unknown[]; prompt?: (text: string) => Promise<void> };
        modelRef: string;
      }>,
      setSessionModel: setSessionModel as unknown as (
        sessionKey: string,
        modelRef: string,
        options?: { persist?: boolean },
      ) => void,
      clearRuntimeModelOverride: vi.fn((_: string) => {}),
      ensureSessionModelForInput: ensureSessionModelForInput as unknown as (params: {
        sessionKey: string;
        agentId: string;
        input: "text" | "image" | "audio" | "video" | "file";
      }) => Promise<
        | { ok: true; modelRef: string; switched: boolean }
        | { ok: false; modelRef: string; candidates: string[] }
      >,
      resetSession: resetSession as unknown as (sessionKey: string) => void,
      ensureChannelContext: (async () => {}) as unknown as (params: unknown) => Promise<void>,
      updateSessionContext: (() => {}) as unknown as (
        sessionKey: string,
        messages: unknown[],
      ) => void,
      updateSessionMetadata: updateSessionMetadata as unknown as (
        sessionKey: string,
        patch: unknown,
      ) => void,
      getSessionMetadata: getSessionMetadata as unknown as (
        sessionKey: string,
      ) => Record<string, unknown> | undefined,
      getPromptMetadata: (() => undefined) as unknown as (sessionKey: string) =>
        | {
            mode: "main" | "reset-greeting" | "subagent-minimal";
            homeDir: string;
            workspaceDir: string;
            loadedFiles: Array<{ name: string; chars: number }>;
            skippedFiles: Array<{ name: string; reason: "missing" | "empty" }>;
            promptHash: string;
          }
        | undefined,
      resolveConfiguredThinkingLevel: resolveConfiguredThinkingLevel as unknown as (
        agentId: string,
      ) => "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | undefined,
      getContextUsage: (() => null) as unknown as (sessionKey: string) => unknown,
      getContextBreakdown: (() => null) as unknown as (sessionKey: string) => unknown,
      getWorkspaceDir: (() => "/tmp/mozi-tests") as unknown as (
        agentId: string,
      ) => string | undefined,
    };
    h.runPromptWithFallback = runPromptWithFallback as unknown as (
      params: unknown,
    ) => Promise<void>;
  });

  it("handles /status", async () => {
    await handler.handle(createMessage("/status"), channel);
    expect(send).toHaveBeenCalledTimes(1);
    expect(ingestInboundMessageMock).not.toHaveBeenCalled();
    expect(updateSessionMetadata).not.toHaveBeenCalled();
    expect(beginTyping).not.toHaveBeenCalled();
    const payload = send.mock.calls[0]?.[1] as { text: string };
    expect(payload.text).toContain("🤖 Mozi");
    expect(payload.text).toContain("🧠 Model: quotio/gemini-3-flash-preview");
    expect(payload.text).toContain("⚙️ Runtime:");
  });

  it("handles /new by rotating current session segment", async () => {
    await handler.handle(createMessage("/new"), channel);
    expect(resetSession).toHaveBeenCalledTimes(1);
    expect(resetSession.mock.calls[0]?.[1]).toBe("mozi");
    const payload = send.mock.calls[0]?.[1] as { text: string };
    expect(payload.text).toContain("what they want to work on now");
  });

  it("uses reset-greeting output as-is without regex fallback", async () => {
    let capturedResetPrompt = "";
    const h = handler as unknown as {
      agentManager: {
        getAgent: (
          sessionKey: string,
          agentId: string,
          options?: { promptMode?: "main" | "reset-greeting" | "subagent-minimal" },
        ) => Promise<{
          agent: { prompt: (text: string) => Promise<void>; messages: unknown[] };
          modelRef: string;
        }>;
      };
    };

    h.agentManager.getAgent = (async (
      _sessionKey: string,
      _agentId: string,
      options?: {
        promptMode?: "main" | "reset-greeting" | "subagent-minimal";
      },
    ) => ({
      agent: {
        prompt: async (text: string) => {
          capturedResetPrompt = text;
        },
        messages:
          options?.promptMode === "reset-greeting"
            ? [{ role: "assistant", content: "I am pi. Nice to meet you." }]
            : [],
      },
      modelRef: "quotio/gemini-3-flash-preview",
    })) as unknown as (
      sessionKey: string,
      agentId: string,
      options?: { promptMode?: "main" | "reset-greeting" | "subagent-minimal" },
    ) => Promise<{
      agent: { prompt: (text: string) => Promise<void>; messages: unknown[] };
      modelRef: string;
    }>;

    await handler.handle(createMessage("/new"), channel);

    const payload = send.mock.calls[0]?.[1] as { text: string };
    expect(payload.text).toContain("I am pi. Nice to meet you.");
    expect(capturedResetPrompt).toContain("Identity/persona are authoritative");
    expect(capturedResetPrompt).toContain("SOUL.md + IDENTITY.md + USER.md");
    expect(capturedResetPrompt).toContain(
      "Language rule: use the language specified by those files",
    );
  });

  it("preserves zh identity greeting output from reset mode without rewriting", async () => {
    const h = handler as unknown as {
      agentManager: {
        getAgent: (
          sessionKey: string,
          agentId: string,
          options?: { promptMode?: "main" | "reset-greeting" | "subagent-minimal" },
        ) => Promise<{
          agent: { prompt: (text: string) => Promise<void>; messages: unknown[] };
          modelRef: string;
        }>;
      };
    };

    h.agentManager.getAgent = (async (
      _sessionKey: string,
      _agentId: string,
      options?: {
        promptMode?: "main" | "reset-greeting" | "subagent-minimal";
      },
    ) => ({
      agent: {
        prompt: async () => {},
        messages:
          options?.promptMode === "reset-greeting"
            ? [
                {
                  role: "assistant",
                  content: "你好，我是 Luka。我们继续推进你现在最重要的任务。",
                },
              ]
            : [],
      },
      modelRef: "quotio/gemini-3-flash-preview",
    })) as unknown as (
      sessionKey: string,
      agentId: string,
      options?: { promptMode?: "main" | "reset-greeting" | "subagent-minimal" },
    ) => Promise<{
      agent: { prompt: (text: string) => Promise<void>; messages: unknown[] };
      modelRef: string;
    }>;

    await handler.handle(createMessage("/new"), channel);

    const payload = send.mock.calls[0]?.[1] as { text: string };
    expect(payload.text).toBe("你好，我是 Luka。我们继续推进你现在最重要的任务。");
  });

  it("falls back to static /new reply when reset greeting turn returns empty", async () => {
    const h = handler as unknown as {
      agentManager: {
        getAgent: (
          sessionKey: string,
          agentId: string,
          options?: { promptMode?: "main" | "reset-greeting" | "subagent-minimal" },
        ) => Promise<{ agent: { prompt: (text: string) => Promise<void>; messages: unknown[] } }>;
      };
    };

    h.agentManager.getAgent = (async () => ({
      agent: {
        prompt: async () => {},
        messages: [],
      },
    })) as unknown as (
      sessionKey: string,
      agentId: string,
      options?: { promptMode?: "main" | "reset-greeting" | "subagent-minimal" },
    ) => Promise<{ agent: { prompt: (text: string) => Promise<void>; messages: unknown[] } }>;

    await handler.handle(createMessage("/new"), channel);

    const payload = send.mock.calls[0]?.[1] as { text: string };
    expect(payload.text).toContain("rotated to a new session segment");
  });

  it("falls back to zh /new reply when identity language hint is zh-CN", async () => {
    const h = handler as unknown as {
      agentManager: {
        getAgent: (
          sessionKey: string,
          agentId: string,
          options?: { promptMode?: "main" | "reset-greeting" | "subagent-minimal" },
        ) => Promise<{
          agent: { prompt: (text: string) => Promise<void>; messages: unknown[] };
          modelRef: string;
          systemPrompt: string;
        }>;
      };
    };

    h.agentManager.getAgent = (async () => ({
      agent: {
        prompt: async () => {},
        messages: [],
      },
      modelRef: "quotio/gemini-3-flash-preview",
      systemPrompt: "# Identity & Persona\n## USER.md\nLanguage preference: zh-CN",
    })) as unknown as (
      sessionKey: string,
      agentId: string,
      options?: { promptMode?: "main" | "reset-greeting" | "subagent-minimal" },
    ) => Promise<{
      agent: { prompt: (text: string) => Promise<void>; messages: unknown[] };
      modelRef: string;
      systemPrompt: string;
    }>;

    await handler.handle(createMessage("/new"), channel);

    const payload = send.mock.calls[0]?.[1] as { text: string };
    expect(payload.text).toContain("新会话已开始");
  });

  it("handles /models by showing available models", async () => {
    await handler.handle(createMessage("/models"), channel);
    expect(setSessionModel).not.toHaveBeenCalled();
    const payload = send.mock.calls[0]?.[1] as { text: string };
    expect(payload.text).toContain("Available models:");
    expect(payload.text).toContain("quotio/gemini-3-flash-preview");
  });

  it("handles /switch without args by showing current model", async () => {
    await handler.handle(createMessage("/switch"), channel);
    expect(setSessionModel).not.toHaveBeenCalled();
    const payload = send.mock.calls[0]?.[1] as { text: string };
    expect(payload.text).toContain("Current model: quotio/gemini-3-flash-preview");
  });

  it("handles /switch with args by switching model", async () => {
    await handler.handle(createMessage("/switch quotio/gemini-3-flash-preview"), channel);
    expect(setSessionModel).toHaveBeenCalledTimes(1);
    expect(setSessionModel.mock.calls[0]?.[1]).toBe("quotio/gemini-3-flash-preview");
  });

  it("handles /switch with typo by auto-correcting to closest model", async () => {
    await handler.handle(createMessage("/switch quotio/gemini-3-flash-perview"), channel);
    expect(setSessionModel).toHaveBeenCalledTimes(1);
    expect(setSessionModel.mock.calls[0]?.[1]).toBe("quotio/gemini-3-flash-preview");
    const payload = send.mock.calls[0]?.[1] as { text: string };
    expect(payload.text).toContain("auto-corrected");
  });

  it("handles /switch unknown by returning suggestions", async () => {
    const h = handler as unknown as {
      modelRegistry: {
        get: (ref: string) => unknown;
        resolve: (ref: string) => unknown;
        suggestRefs: (ref: string) => string[];
        list: () => Array<{ provider: string; id: string }>;
      };
    };
    h.modelRegistry = {
      get: () => ({}),
      resolve: () => undefined,
      suggestRefs: () => ["quotio/gemini-3-flash-preview", "quotio/gemini-3-pro-preview"],
      list: () => [{ provider: "quotio", id: "gemini-3-flash-preview" }],
    };

    await handler.handle(createMessage("/switch quotio/unknown-model"), channel);
    expect(setSessionModel).not.toHaveBeenCalled();
    const payload = send.mock.calls[0]?.[1] as { text: string };
    expect(payload.text).toContain("Model not found");
    expect(payload.text).toContain("quotio/gemini-3-flash-preview");
  });

  it("handles /restart via runtime control callback", async () => {
    await handler.handle(createMessage("/restart"), channel);
    expect(restart).toHaveBeenCalledTimes(1);
    const payload = send.mock.calls[0]?.[1] as { text: string };
    expect(payload.text).toContain("Restarting runtime");
  });

  it("handles implicit Chinese heartbeat cancel intent without invoking model prompt", async () => {
    await handler.handle(createMessage("取消心跳"), channel);

    expect(runPromptWithFallback).not.toHaveBeenCalled();
    expect(fsWriteFileMock).toHaveBeenCalledTimes(1);
    const payload = send.mock.calls[0]?.[1] as { text: string };
    expect(payload.text).toContain("Heartbeat disabled");
  });

  it("handles /heartbeat status", async () => {
    fsReadFileMock.mockResolvedValue("@heartbeat enabled=off\n");

    await handler.handle(createMessage("/heartbeat status"), channel);

    expect(runPromptWithFallback).not.toHaveBeenCalled();
    const payload = send.mock.calls[0]?.[1] as { text: string };
    expect(payload.text).toContain("disabled");
  });

  it("handles /stop by interrupting active run", async () => {
    const h = handler as unknown as {
      interruptSession: (sessionKey: string, reason?: string) => Promise<boolean>;
    };
    h.interruptSession = vi.fn(async () => true);

    await handler.handle(createMessage("/stop"), channel);

    expect(runPromptWithFallback).not.toHaveBeenCalled();
    expect(h.interruptSession).toHaveBeenCalledTimes(1);
    const payload = send.mock.calls[0]?.[1] as { text: string };
    expect(payload.text).toContain("Stopped active run");
  });

  it("handles /setAuth when auth is disabled", async () => {
    await handler.handle(createMessage("/setAuth TEST_KEY=abc"), channel);
    const payload = send.mock.calls[0]?.[1] as { text: string };
    expect(payload.text).toContain("Auth broker is disabled");
  });

  it("handles /checkAuth when auth is disabled", async () => {
    await handler.handle(createMessage("/checkAuth TEST_KEY"), channel);
    const payload = send.mock.calls[0]?.[1] as { text: string };
    expect(payload.text).toContain("Auth broker is disabled");
  });

  it("ignores unknown slash commands", async () => {
    await handler.handle(createMessage("/unknown"), channel);
    expect(send).not.toHaveBeenCalled();
    expect(runPromptWithFallback).not.toHaveBeenCalled();
  });

  it("handles /think with explicit level and persists session override", async () => {
    await handler.handle(createMessage("/think high"), channel);

    expect(updateSessionMetadata).toHaveBeenCalledWith(
      "agent:mozi:telegram:dm:chat-1",
      expect.objectContaining({ thinkingLevel: "high" }),
    );
    const payload = send.mock.calls[0]?.[1] as { text: string };
    expect(payload.text).toContain("Thinking level set to: high");
  });

  it("handles /think without args by showing current level", async () => {
    getSessionMetadata.mockReturnValue({ thinkingLevel: "medium" });

    await handler.handle(createMessage("/think"), channel);

    const payload = send.mock.calls[0]?.[1] as { text: string };
    expect(payload.text).toContain("Current thinking level: medium");
  });

  it("handles /reasoning and persists reasoning visibility", async () => {
    await handler.handle(createMessage("/reasoning on"), channel);

    expect(updateSessionMetadata).toHaveBeenCalledWith(
      "agent:mozi:telegram:dm:chat-1",
      expect.objectContaining({ reasoningLevel: "on" }),
    );
    const payload = send.mock.calls[0]?.[1] as { text: string };
    expect(payload.text).toContain("Reasoning level set to: on");
  });

  it("supports think/reasoning aliases", async () => {
    await handler.handle(createMessage("/t low"), channel);
    await handler.handle(createMessage("/reason off"), channel);

    expect(updateSessionMetadata).toHaveBeenNthCalledWith(
      1,
      "agent:mozi:telegram:dm:chat-1",
      expect.objectContaining({ thinkingLevel: "low" }),
    );
    expect(updateSessionMetadata).toHaveBeenNthCalledWith(
      2,
      "agent:mozi:telegram:dm:chat-1",
      expect.objectContaining({ reasoningLevel: "off" }),
    );
  });

  it("supports inline /think override for a single prompt turn", async () => {
    await handler.handle(createMessage("/think high -- explain this quickly"), channel);

    expect(runPromptWithFallback).toHaveBeenCalledTimes(1);
    const params = runPromptWithFallback.mock.calls[0]?.[0] as { text: string };
    expect(params.text).toContain("explain this quickly");

    const patches = updateSessionMetadata.mock.calls.map(
      (call) => call[1] as Record<string, unknown>,
    );
    expect(patches.some((p) => p.thinkingLevel === "high")).toBe(true);
    expect(patches.some((p) => Object.prototype.hasOwnProperty.call(p, "thinkingLevel"))).toBe(
      true,
    );
  });

  it("shows effective thinking/reasoning in /status", async () => {
    getSessionMetadata.mockReturnValue({ thinkingLevel: "medium", reasoningLevel: "on" });

    await handler.handle(createMessage("/status"), channel);

    const payload = send.mock.calls[0]?.[1] as { text: string };
    expect(payload.text).toContain("🧭 Thinking: medium");
    expect(payload.text).toContain("🪄 Reasoning: on");
  });

  it("shows pruning and memory policy in /context", async () => {
    const h = handler as unknown as {
      agentManager: {
        getContextBreakdown: (sessionKey: string) => {
          systemPromptTokens: number;
          userMessageTokens: number;
          assistantMessageTokens: number;
          toolResultTokens: number;
          totalTokens: number;
        } | null;
        getContextUsage: (sessionKey: string) => {
          usedTokens: number;
          totalTokens: number;
          percentage: number;
          messageCount: number;
        } | null;
      };
    };
    h.agentManager.getContextBreakdown = () => ({
      systemPromptTokens: 120,
      userMessageTokens: 300,
      assistantMessageTokens: 220,
      toolResultTokens: 80,
      totalTokens: 720,
    });
    h.agentManager.getContextUsage = () => ({
      usedTokens: 720,
      totalTokens: 2000,
      percentage: 36,
      messageCount: 12,
    });

    await handler.handle(createMessage("/context"), channel);

    const payload = send.mock.calls[0]?.[1] as { text: string };
    expect(payload.text).toContain("Pruning:");
    expect(payload.text).toContain("Memory persistence:");
  });

  it("hides think tags in final reply when reasoning level is stream", async () => {
    getSessionMetadata.mockReturnValue({ reasoningLevel: "stream" });
    const editMessage = vi.fn(async () => {});
    (channel as unknown as { editMessage?: typeof editMessage }).editMessage = editMessage;

    const h = handler as unknown as {
      agentManager: {
        getAgent: (
          sessionKey: string,
          agentId: string,
        ) => Promise<{
          agent: { messages: Array<{ role: string; content: string }> };
          modelRef: string;
        }>;
      };
      runPromptWithFallback: (params: {
        sessionKey: string;
        agentId: string;
        text: string;
        onStream?: (event: {
          type: "text_delta" | "agent_end";
          delta?: string;
          fullText?: string;
        }) => void;
      }) => Promise<void>;
    };
    h.runPromptWithFallback = vi.fn(async (params) => {
      params.onStream?.({ type: "text_delta", delta: "partial" });
      params.onStream?.({ type: "agent_end", fullText: "visible" });
    });
    h.agentManager.getAgent = async () => ({
      modelRef: "quotio/gemini-3-flash-preview",
      agent: {
        messages: [{ role: "assistant", content: "<think>secret</think>visible" }],
      },
    });

    await handler.handle(createMessage("hello"), channel);

    const deliveredTexts = [
      ...send.mock.calls.map((call) => (call[1] as { text?: string }).text || ""),
      ...editMessage.mock.calls.map((call) => {
        const tuple = call as unknown[];
        const text = tuple.length > 2 ? tuple[2] : undefined;
        return typeof text === "string" ? text : "";
      }),
    ];
    const finalText = deliveredTexts.at(-1) || "";
    expect(finalText).toContain("visible");
    expect(finalText).not.toContain("secret");
  });

  it("strips leaked reasoning preamble from final external reply", async () => {
    getSessionMetadata.mockReturnValue({ reasoningLevel: "off" });

    const h = handler as unknown as {
      runPromptWithFallback: (params: {
        onStream?: (event: { type: "agent_end"; fullText?: string }) => void;
      }) => Promise<void>;
    };

    h.runPromptWithFallback = vi.fn(async (params) => {
      params.onStream?.({
        type: "agent_end",
        fullText: "Reasoning:\n用户用中文说你好。\n\n你好！有什么我可以帮助你的吗？",
      });
    });

    await handler.handle(createMessage("你好"), channel);

    const deliveredTexts = send.mock.calls.map((call) => (call[1] as { text?: string }).text || "");
    const finalText = deliveredTexts.at(-1) || "";
    expect(finalText).toBe("你好！有什么我可以帮助你的吗？");
    expect(finalText).not.toContain("Reasoning:");
  });

  it("does not stream think-tag internals to external channel edits", async () => {
    getSessionMetadata.mockReturnValue({ reasoningLevel: "off" });

    const h = handler as unknown as {
      runPromptWithFallback: (params: {
        onStream?: (event: {
          type: "text_delta" | "agent_end";
          delta?: string;
          fullText?: string;
        }) => Promise<void> | void;
      }) => Promise<void>;
    };

    h.runPromptWithFallback = vi.fn(async (params) => {
      await params.onStream?.({ type: "text_delta", delta: "<th" });
      await params.onStream?.({ type: "text_delta", delta: "ink>内部推理</think>" });
      await params.onStream?.({ type: "text_delta", delta: "你好" });
      await params.onStream?.({ type: "agent_end", fullText: "<think>内部推理</think>你好" });
    });

    await handler.handle(createMessage("你好"), channel);

    const sentTexts = send.mock.calls.map((call) => (call[1] as { text?: string }).text || "");
    const editedTexts = editMessageMock.mock.calls.map((call) => (call[2] as string) || "");
    const delivered = [...sentTexts, ...editedTexts].join("\n");

    expect(delivered).toContain("你好");
    expect(delivered).not.toContain("内部推理");
    expect(delivered).not.toContain("<think>");
  });

  it("does not rewrite identity replies with regex fallback", async () => {
    getSessionMetadata.mockReturnValue({ reasoningLevel: "off" });

    const h = handler as unknown as {
      runPromptWithFallback: (params: {
        onStream?: (event: { type: "agent_end"; fullText?: string }) => void;
      }) => Promise<void>;
    };

    h.runPromptWithFallback = vi.fn(async (params) => {
      params.onStream?.({
        type: "agent_end",
        fullText: "我是 pi，一个 AI 编程助手。",
      });
    });

    await handler.handle(createMessage("你是谁"), channel);

    const deliveredTexts = send.mock.calls.map((call) => (call[1] as { text?: string }).text || "");
    const finalText = deliveredTexts.at(-1) || "";
    expect(finalText).toContain("我是 pi，一个 AI 编程助手。");
  });

  it("attempts pre-overflow memory flush when context usage is high", async () => {
    const config = createConfig();
    config.memory = {
      persistence: {
        enabled: true,
        onOverflowCompaction: true,
        onNewReset: true,
        maxMessages: 4,
        maxChars: 500,
        timeoutMs: 100,
      },
      backend: "builtin",
      citations: "auto",
    };
    const flushHandler = new MessageHandler(config);

    const fh = flushHandler as unknown as {
      router: { resolve: (msg: InboundMessage, defaultAgentId: string) => { agentId: string } };
      runPromptWithFallback: (params: unknown) => Promise<void>;
      agentManager: {
        resolveDefaultAgentId: () => string;
        getAgent: (
          sessionKey: string,
          agentId: string,
          options?: { promptMode?: "main" | "reset-greeting" | "subagent-minimal" },
        ) => Promise<{ agent: { messages: unknown[] }; modelRef: string }>;
        ensureChannelContext: (params: unknown) => Promise<void>;
        updateSessionMetadata: (sessionKey: string, patch: unknown) => void;
        getContextUsage: (sessionKey: string) => {
          usedTokens: number;
          totalTokens: number;
          percentage: number;
          messageCount: number;
        } | null;
      };
    };
    const update = vi.fn(() => {});
    fh.router = { resolve: () => ({ agentId: "mozi" }) };
    fh.runPromptWithFallback = vi.fn(async () => {});
    fh.agentManager.resolveDefaultAgentId = () => "mozi";
    fh.agentManager.ensureChannelContext = async () => {};
    fh.agentManager.getContextUsage = () => ({
      usedTokens: 900,
      totalTokens: 1000,
      percentage: 90,
      messageCount: 20,
    });
    fh.agentManager.updateSessionMetadata = update;
    fh.agentManager.getAgent = async () => ({
      modelRef: "quotio/gemini-3-flash-preview",
      agent: {
        messages: [{ role: "user", content: "hi" }],
      },
    });

    await flushHandler.handle(createMessage("ping"), channel);

    const updateCalls = update.mock.calls as unknown[][];
    expect(
      updateCalls.some(
        (call) =>
          typeof call[1] === "object" &&
          call[1] !== null &&
          "memoryFlush" in (call[1] as Record<string, unknown>),
      ),
    ).toBe(true);
  });

  it("auto switches to vision model for media input", async () => {
    let activeModelRef = "quotio/gemini-3-flash-preview";
    const h = handler as unknown as {
      agentManager: {
        getAgent: (
          sessionKey: string,
          agentId: string,
          options?: { promptMode?: "main" | "reset-greeting" | "subagent-minimal" },
        ) => Promise<{ agent: { messages: unknown[] }; modelRef: string }>;
      };
    };
    h.agentManager.getAgent = (async () => ({
      agent: { messages: [] },
      modelRef: activeModelRef,
    })) as unknown as (
      sessionKey: string,
      agentId: string,
    ) => Promise<{ agent: { messages: unknown[] }; modelRef: string }>;

    ensureSessionModelForInput.mockResolvedValue({
      ok: true,
      modelRef: "quotio/gemini-3-pro-image-preview",
      switched: true,
    });
    ensureSessionModelForInput.mockImplementation(async () => {
      activeModelRef = "quotio/gemini-3-pro-image-preview";
      return {
        ok: true as const,
        modelRef: "quotio/gemini-3-pro-image-preview",
        switched: true,
      };
    });

    await handler.handle(createMediaMessage("look at this"), channel);

    expect(ensureSessionModelForInput).toHaveBeenCalledTimes(1);
    expect(runPromptWithFallback).toHaveBeenCalledTimes(1);
    expect(ingestInboundMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        modelRef: "quotio/gemini-3-pro-image-preview",
      }),
    );
    const switchedNotice = send.mock.calls
      .map((call) => (call[1] as { text?: string }).text || "")
      .find((line) => line.includes("auto-switched model"));
    expect(switchedNotice).toBeUndefined();
    expect(setSessionModel).toHaveBeenCalledWith(
      "agent:mozi:telegram:dm:chat-1",
      "quotio/gemini-3-flash-preview",
    );
  });

  it("degrades media input to text when no modality model is available", async () => {
    ensureSessionModelForInput.mockResolvedValue({
      ok: false,
      modelRef: "quotio/gemini-3-flash-preview",
      candidates: ["quotio/gemini-3-pro-image-preview"],
    });

    await handler.handle(createMediaMessage("look at this"), channel);

    expect(runPromptWithFallback).toHaveBeenCalledTimes(1);
    const degradedNotice = send.mock.calls
      .map((call) => (call[1] as { text?: string }).text || "")
      .find((line) => line.includes("Continuing with text degradation"));
    expect(degradedNotice).toContain("quotio/gemini-3-pro-image-preview");
    expect(degradedNotice).toContain("agents.mozi.imageModel");
    expect(degradedNotice).toContain("agents.defaults.imageModel");
  });

  it("sends user-visible fallback notice when primary model fails", async () => {
    runPromptWithFallback.mockImplementation(
      async (params: {
        onFallback?: (info: {
          fromModel: string;
          toModel: string;
          attempt: number;
          error: string;
        }) => Promise<void> | void;
      }) => {
        await params.onFallback?.({
          fromModel: "quotio/gemini-3-flash-preview",
          toModel: "quotio/local/minimax-m2.1",
          attempt: 1,
          error: "400 model failure",
        });
      },
    );

    await handler.handle(createMessage("hello"), channel);

    const notice = send.mock.calls
      .map((call) => (call[1] as { text?: string }).text || "")
      .find((line) => line.includes("Primary model failed this turn"));
    expect(notice).toContain("quotio/local/minimax-m2.1");
  });

  it("delivers final content when stream edit fails after fallback switch", async () => {
    const editMessage = vi.fn(async () => {
      throw new Error("telegram edit failed");
    });
    (channel as unknown as { editMessage?: typeof editMessage }).editMessage = editMessage;

    const h = handler as unknown as {
      agentManager: {
        getAgent: (
          sessionKey: string,
          agentId: string,
        ) => Promise<{
          agent: { messages: Array<{ role: string; content: string }> };
          modelRef: string;
        }>;
      };
      runPromptWithFallback: (params: {
        onFallback?: (info: {
          fromModel: string;
          toModel: string;
          attempt: number;
          error: string;
        }) => Promise<void> | void;
        onStream?: (event: { type: "text_delta"; delta?: string }) => Promise<void> | void;
      }) => Promise<void>;
    };

    h.runPromptWithFallback = vi.fn(async (params) => {
      await params.onFallback?.({
        fromModel: "quotio/gemini-3-flash-preview",
        toModel: "quotio/local/minimax-m2.1",
        attempt: 1,
        error: "400 model failure",
      });
      await params.onStream?.({ type: "text_delta", delta: "draft response" });
      await params.onStream?.({ type: "agent_end", fullText: "final response" } as never);
    });

    h.agentManager.getAgent = async () => ({
      modelRef: "quotio/local/minimax-m2.1",
      agent: {
        messages: [{ role: "assistant", content: "final response" }],
      },
    });

    await handler.handle(createMessage("hello"), channel);

    const sentTexts = send.mock.calls.map((call) => (call[1] as { text?: string }).text || "");
    const editedTexts = editMessage.mock.calls.map((call) => {
      const tuple = call as unknown[];
      const text = tuple.length > 2 ? tuple[2] : undefined;
      return typeof text === "string" ? text : "";
    });
    const allTexts = [...sentTexts, ...editedTexts];
    const fallbackNotice = sentTexts.find((line) =>
      line.includes("Primary model failed this turn"),
    );
    const finalSent = allTexts.find((line) => line === "final response");

    expect(fallbackNotice).toContain("quotio/local/minimax-m2.1");
    expect(finalSent).toBe("final response");
    expect(allTexts.includes("(no response)")).toBe(false);
  });

  it("does not stream partial placeholder when channel has no editMessage capability", async () => {
    const channelWithoutEdit = {
      ...channel,
    } as unknown as ChannelPlugin & { editMessage?: unknown };
    delete channelWithoutEdit.editMessage;

    const h = handler as unknown as {
      runPromptWithFallback: (params: {
        onStream?: (event: {
          type: "text_delta" | "agent_end";
          delta?: string;
          fullText?: string;
        }) => Promise<void> | void;
      }) => Promise<void>;
      agentManager: {
        getAgent: (
          sessionKey: string,
          agentId: string,
        ) => Promise<{
          agent: { messages: Array<{ role: string; content: string }> };
          modelRef: string;
        }>;
      };
    };

    h.runPromptWithFallback = vi.fn(async (params) => {
      await params.onStream?.({
        type: "text_delta",
        delta: "我是 pi 的 AI 编程助手 🤖\n\n让我看看我的 home 目录有什么",
      });
      await params.onStream?.({
        type: "agent_end",
        fullText:
          "我是 pi 的 AI 编程助手 🤖\n\n我的 home 目录是 `/Users/royzhu`，里面有很多文件和文件夹。",
      });
    });

    h.agentManager.getAgent = async () => ({
      modelRef: "minimax/MiniMax-M2.5",
      agent: {
        messages: [
          {
            role: "assistant",
            content: "我的 home 目录是 `/Users/royzhu`，里面有很多文件和文件夹。",
          },
        ],
      },
    });

    await handler.handle(
      createMessage("你是谁？你的home目录里有什么"),
      channelWithoutEdit as ChannelPlugin,
    );

    const sentTexts = send.mock.calls.map((call) => (call[1] as { text?: string }).text || "");
    expect(sentTexts[0]).toContain("我的 home 目录是");
    expect(sentTexts[0]).not.toContain("让我看看我的 home 目录有什么");
  });

  it("does not send audio degradation notice when transcript is available", async () => {
    ensureSessionModelForInput.mockResolvedValue({
      ok: false,
      modelRef: "quotio/gemini-3-flash-preview",
      candidates: [],
    });
    preprocessInboundMessageMock.mockResolvedValue({
      transcript: "transcribed audio content",
      hasAudioTranscript: true,
    });

    await handler.handle(createAudioMessage(""), channel);

    const degradedNotice = send.mock.calls
      .map((call) => (call[1] as { text?: string }).text || "")
      .find((line) => line.includes("does not support audio input"));
    expect(degradedNotice).toBeUndefined();
    expect(runPromptWithFallback).toHaveBeenCalledTimes(1);
  });

  it("skips audio capability routing when transcript is available", async () => {
    preprocessInboundMessageMock.mockResolvedValue({
      transcript: "audio transcript",
      hasAudioTranscript: true,
    });

    await handler.handle(createAudioMessage("listen this"), channel);

    expect(ensureSessionModelForInput).not.toHaveBeenCalledWith(
      expect.objectContaining({ input: "audio" }),
    );
  });

  it("injects voice transcript into prompt when available", async () => {
    preprocessInboundMessageMock.mockResolvedValue({
      transcript: "This is a voice transcript",
      hasAudioTranscript: true,
    });

    await handler.handle(createAudioMessage(""), channel);

    const promptCall = runPromptWithFallback.mock.calls[0]?.[0] as { text: string };
    expect(promptCall.text).toContain("This is a voice transcript");
  });

  it("allows concurrent invocations and delegates serialization to runtime kernel", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    runPromptWithFallback.mockImplementation(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 20));
      inFlight -= 1;
    });

    await Promise.all([
      handler.handle(createMessage("hello A"), channel),
      handler.handle(createMessage("hello B"), channel),
    ]);

    expect(runPromptWithFallback).toHaveBeenCalledTimes(2);
    expect(maxInFlight).toBe(2);
  });

  it("surfaces missing auth guidance when prompt fails with AUTH_MISSING", async () => {
    runPromptWithFallback.mockRejectedValue(new Error("AUTH_MISSING OPENAI_API_KEY"));

    await handler.handle(createMessage("hello"), channel);

    const last = send.mock.calls.at(-1)?.[1] as { text: string };
    expect(last.text).toContain("Missing authentication secret OPENAI_API_KEY");
    expect(last.text).toContain("/setAuth set OPENAI_API_KEY=<value>");
  });

  it("starts and stops typing indicator for normal messages", async () => {
    await handler.handle(createMessage("hello"), channel);

    expect(beginTyping).toHaveBeenCalledTimes(1);
    expect(beginTyping).toHaveBeenCalledWith("chat-1");
    expect(stopTyping).toHaveBeenCalledTimes(1);
  });

  it("emits phase transitions for normal prompt flow", async () => {
    await handler.handle(createMessage("hello"), channel);

    const phases = emitPhase.mock.calls.map((call) => call[1]);
    expect(phases[0]).toBe("thinking");
    expect(phases).toContain("speaking");
    expect(phases[phases.length - 1]).toBe("idle");
  });

  it("session_rollover_temporal_expired", async () => {
    const realHandler = new MessageHandler(createConfigWithTemporalLifecycle(), {
      runtimeControl: {
        getStatus: () => ({ running: true, pid: 123, uptime: 42 }),
        restart: restart as unknown as () => Promise<void>,
      },
    });
    const h = realHandler as unknown as {
      agentManager: {
        resolveDefaultAgentId: () => string;
        getAgent: (
          sessionKey: string,
          agentId: string,
          options?: { promptMode?: "main" | "reset-greeting" | "subagent-minimal" },
        ) => Promise<{ agent: { messages: unknown[] }; modelRef: string }>;
        resetSession: (sessionKey: string, agentId: string) => void;
        ensureSessionModelForInput: (params: {
          sessionKey: string;
          agentId: string;
          input: "text" | "image" | "audio" | "video" | "file";
        }) => Promise<{ ok: true; modelRef: string; switched: boolean }>;
        ensureChannelContext: (params: unknown) => Promise<void>;
        updateSessionContext: (sessionKey: string, messages: unknown[]) => void;
        updateSessionMetadata: (sessionKey: string, patch: unknown) => void;
      };
      sessions: {
        getOrCreate: (
          sessionKey: string,
          agentId: string,
        ) => { createdAt?: number; updatedAt?: number };
      };
      runPromptWithFallback: (params: unknown) => Promise<void>;
    };

    const rotateSpy = vi.fn(() => {});
    h.agentManager.resetSession = rotateSpy;
    h.agentManager.resolveDefaultAgentId = () => "mozi";
    h.agentManager.getAgent = (async () => ({
      agent: { messages: [] },
      modelRef: "quotio/gemini-3-flash-preview",
    })) as unknown as (
      sessionKey: string,
      agentId: string,
    ) => Promise<{ agent: { messages: unknown[] }; modelRef: string }>;
    h.agentManager.ensureSessionModelForInput = (async () => ({
      ok: true,
      modelRef: "quotio/gemini-3-flash-preview",
      switched: false,
    })) as unknown as (params: {
      sessionKey: string;
      agentId: string;
      input: "text" | "image" | "audio" | "video" | "file";
    }) => Promise<{ ok: true; modelRef: string; switched: boolean }>;
    h.agentManager.ensureChannelContext = (async () => {}) as unknown as (
      params: unknown,
    ) => Promise<void>;
    h.agentManager.updateSessionContext = (() => {}) as unknown as (
      sessionKey: string,
      messages: unknown[],
    ) => void;
    h.agentManager.updateSessionMetadata = (() => {}) as unknown as (
      sessionKey: string,
      patch: unknown,
    ) => void;
    h.sessions.getOrCreate = () => ({ updatedAt: Date.now() - 13 * 60 * 60 * 1000 });
    h.runPromptWithFallback = (async () => {}) as unknown as (params: unknown) => Promise<void>;

    await realHandler.handle(createMessage("hello"), channel);
    expect(rotateSpy).toHaveBeenCalledTimes(1);
  });

  it("session_rollover_temporal_within_window_noop", async () => {
    const realHandler = new MessageHandler(createConfigWithTemporalLifecycle(), {
      runtimeControl: {
        getStatus: () => ({ running: true, pid: 123, uptime: 42 }),
        restart: restart as unknown as () => Promise<void>,
      },
    });
    const h = realHandler as unknown as {
      agentManager: {
        resolveDefaultAgentId: () => string;
        getAgent: (
          sessionKey: string,
          agentId: string,
          options?: { promptMode?: "main" | "reset-greeting" | "subagent-minimal" },
        ) => Promise<{ agent: { messages: unknown[] }; modelRef: string }>;
        resetSession: (sessionKey: string, agentId: string) => void;
        ensureSessionModelForInput: (params: {
          sessionKey: string;
          agentId: string;
          input: "text" | "image" | "audio" | "video" | "file";
        }) => Promise<{ ok: true; modelRef: string; switched: boolean }>;
        ensureChannelContext: (params: unknown) => Promise<void>;
        updateSessionContext: (sessionKey: string, messages: unknown[]) => void;
        updateSessionMetadata: (sessionKey: string, patch: unknown) => void;
      };
      sessions: {
        getOrCreate: (
          sessionKey: string,
          agentId: string,
        ) => { createdAt?: number; updatedAt?: number };
      };
      runPromptWithFallback: (params: unknown) => Promise<void>;
    };

    const rotateSpy = vi.fn(() => {});
    h.agentManager.resetSession = rotateSpy;
    h.agentManager.resolveDefaultAgentId = () => "mozi";
    h.agentManager.getAgent = (async () => ({
      agent: { messages: [] },
      modelRef: "quotio/gemini-3-flash-preview",
    })) as unknown as (
      sessionKey: string,
      agentId: string,
    ) => Promise<{ agent: { messages: unknown[] }; modelRef: string }>;
    h.agentManager.ensureSessionModelForInput = (async () => ({
      ok: true,
      modelRef: "quotio/gemini-3-flash-preview",
      switched: false,
    })) as unknown as (params: {
      sessionKey: string;
      agentId: string;
      input: "text" | "image" | "audio" | "video" | "file";
    }) => Promise<{ ok: true; modelRef: string; switched: boolean }>;
    h.agentManager.ensureChannelContext = (async () => {}) as unknown as (
      params: unknown,
    ) => Promise<void>;
    h.agentManager.updateSessionContext = (() => {}) as unknown as (
      sessionKey: string,
      messages: unknown[],
    ) => void;
    h.agentManager.updateSessionMetadata = (() => {}) as unknown as (
      sessionKey: string,
      patch: unknown,
    ) => void;
    h.sessions.getOrCreate = () => ({ updatedAt: Date.now() });
    h.runPromptWithFallback = (async () => {}) as unknown as (params: unknown) => Promise<void>;

    await realHandler.handle(createMessage("hello"), channel);
    expect(rotateSpy).toHaveBeenCalledTimes(0);
  });

  it("session_rollover_semantic_high_confidence_disabled", async () => {
    const realHandler = new MessageHandler(
      createConfigWithSemanticLifecycle({ threshold: 0.6, debounceSeconds: 0 }),
      {
        runtimeControl: {
          getStatus: () => ({ running: true, pid: 123, uptime: 42 }),
          restart: restart as unknown as () => Promise<void>,
        },
      },
    );

    const h = realHandler as unknown as {
      agentManager: {
        resolveDefaultAgentId: () => string;
        getAgent: (
          sessionKey: string,
          agentId: string,
          options?: { promptMode?: "main" | "reset-greeting" | "subagent-minimal" },
        ) => Promise<{ agent: { messages: unknown[] }; modelRef: string }>;
        resetSession: (sessionKey: string, agentId: string) => void;
        ensureSessionModelForInput: (params: {
          sessionKey: string;
          agentId: string;
          input: "text" | "image" | "audio" | "video" | "file";
        }) => Promise<{ ok: true; modelRef: string; switched: boolean }>;
        ensureChannelContext: (params: unknown) => Promise<void>;
        updateSessionContext: (sessionKey: string, messages: unknown[]) => void;
        updateSessionMetadata: (sessionKey: string, patch: unknown) => void;
        resolveLifecycleControlModel: (params: { sessionKey: string; agentId?: string }) => {
          modelRef: string;
          source: "session" | "agent" | "defaults" | "fallback";
        };
      };
      sessions: {
        getOrCreate: (
          sessionKey: string,
          agentId: string,
        ) => {
          createdAt?: number;
          updatedAt?: number;
          context?: unknown[];
          metadata?: Record<string, unknown>;
        };
      };
      runPromptWithFallback: (params: unknown) => Promise<void>;
    };

    const rotateSpy = vi.fn(() => {});
    h.agentManager.resetSession = rotateSpy;
    h.agentManager.resolveDefaultAgentId = () => "mozi";
    h.agentManager.getAgent = (async () => ({
      agent: { messages: [] },
      modelRef: "quotio/gemini-3-flash-preview",
    })) as unknown as (
      sessionKey: string,
      agentId: string,
    ) => Promise<{ agent: { messages: unknown[] }; modelRef: string }>;
    h.agentManager.ensureSessionModelForInput = (async () => ({
      ok: true,
      modelRef: "quotio/gemini-3-flash-preview",
      switched: false,
    })) as unknown as (params: {
      sessionKey: string;
      agentId: string;
      input: "text" | "image" | "audio" | "video" | "file";
    }) => Promise<{ ok: true; modelRef: string; switched: boolean }>;
    h.agentManager.ensureChannelContext = (async () => {}) as unknown as (
      params: unknown,
    ) => Promise<void>;
    h.agentManager.updateSessionContext = (() => {}) as unknown as (
      sessionKey: string,
      messages: unknown[],
    ) => void;
    h.agentManager.updateSessionMetadata = (() => {}) as unknown as (
      sessionKey: string,
      patch: unknown,
    ) => void;
    h.agentManager.resolveLifecycleControlModel = () => ({
      modelRef: "quotio/control-mini",
      source: "defaults",
    });
    h.sessions.getOrCreate = () => ({
      updatedAt: Date.now(),
      context: [{ role: "user", content: "debug docker issue" }],
      metadata: {},
    });
    h.runPromptWithFallback = (async () => {}) as unknown as (params: unknown) => Promise<void>;

    await realHandler.handle(createMessage("design a marketing slogan for my app"), channel);
    expect(rotateSpy).toHaveBeenCalledTimes(0);
  });

  it("semantic_rollover_debounce", async () => {
    const realHandler = new MessageHandler(
      createConfigWithSemanticLifecycle({ threshold: 0.6, debounceSeconds: 120 }),
      {
        runtimeControl: {
          getStatus: () => ({ running: true, pid: 123, uptime: 42 }),
          restart: restart as unknown as () => Promise<void>,
        },
      },
    );

    const h = realHandler as unknown as {
      agentManager: {
        resolveDefaultAgentId: () => string;
        getAgent: (
          sessionKey: string,
          agentId: string,
          options?: { promptMode?: "main" | "reset-greeting" | "subagent-minimal" },
        ) => Promise<{ agent: { messages: unknown[] }; modelRef: string }>;
        resetSession: (sessionKey: string, agentId: string) => void;
        ensureSessionModelForInput: (params: {
          sessionKey: string;
          agentId: string;
          input: "text" | "image" | "audio" | "video" | "file";
        }) => Promise<{ ok: true; modelRef: string; switched: boolean }>;
        ensureChannelContext: (params: unknown) => Promise<void>;
        updateSessionContext: (sessionKey: string, messages: unknown[]) => void;
        updateSessionMetadata: (sessionKey: string, patch: unknown) => void;
        resolveLifecycleControlModel: (params: { sessionKey: string; agentId?: string }) => {
          modelRef: string;
          source: "session" | "agent" | "defaults" | "fallback";
        };
      };
      sessions: {
        getOrCreate: (
          sessionKey: string,
          agentId: string,
        ) => {
          createdAt?: number;
          updatedAt?: number;
          context?: unknown[];
          metadata?: Record<string, unknown>;
        };
      };
      runPromptWithFallback: (params: unknown) => Promise<void>;
    };

    const rotateSpy = vi.fn(() => {});
    h.agentManager.resetSession = rotateSpy;
    h.agentManager.resolveDefaultAgentId = () => "mozi";
    h.agentManager.getAgent = (async () => ({
      agent: { messages: [] },
      modelRef: "quotio/gemini-3-flash-preview",
    })) as unknown as (
      sessionKey: string,
      agentId: string,
    ) => Promise<{ agent: { messages: unknown[] }; modelRef: string }>;
    h.agentManager.ensureSessionModelForInput = (async () => ({
      ok: true,
      modelRef: "quotio/gemini-3-flash-preview",
      switched: false,
    })) as unknown as (params: {
      sessionKey: string;
      agentId: string;
      input: "text" | "image" | "audio" | "video" | "file";
    }) => Promise<{ ok: true; modelRef: string; switched: boolean }>;
    h.agentManager.ensureChannelContext = (async () => {}) as unknown as (
      params: unknown,
    ) => Promise<void>;
    h.agentManager.updateSessionContext = (() => {}) as unknown as (
      sessionKey: string,
      messages: unknown[],
    ) => void;
    h.agentManager.updateSessionMetadata = (() => {}) as unknown as (
      sessionKey: string,
      patch: unknown,
    ) => void;
    h.agentManager.resolveLifecycleControlModel = () => ({
      modelRef: "quotio/control-mini",
      source: "defaults",
    });
    h.sessions.getOrCreate = () => ({
      updatedAt: Date.now(),
      context: [{ role: "user", content: "debug docker issue" }],
      metadata: {
        lifecycle: {
          semantic: {
            lastRotationAt: Date.now() - 10_000,
            lastRotationType: "semantic",
          },
        },
      },
    });
    h.runPromptWithFallback = (async () => {}) as unknown as (params: unknown) => Promise<void>;

    await realHandler.handle(createMessage("design a marketing slogan for my app"), channel);
    expect(rotateSpy).toHaveBeenCalledTimes(0);
  });
});
