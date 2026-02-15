import { describe, expect, it, vi } from "vitest";
import type { MoziConfig } from "../../config";
import { MessageHandler } from "./message-handler";

type SetSessionModelFn = (
  sessionKey: string,
  modelRef: string,
  options?: { persist?: boolean },
) => void;

function createConfig(): MoziConfig {
  return {
    models: {
      providers: {
        quotio: {
          api: "openai-responses",
          baseUrl: "https://example.invalid/v1",
          apiKey: "test-key",
          models: [{ id: "gemini-3-flash-preview" }, { id: "fallback-model" }],
        },
      },
    },
    agents: {
      mozi: {
        model: {
          primary: "quotio/gemini-3-flash-preview",
          fallbacks: ["quotio/fallback-model"],
        },
      },
    },
  };
}

describe("MessageHandler fallback behavior", () => {
  it("retries same model when agent reports busy", async () => {
    const handler = new MessageHandler(createConfig());

    let shouldFailBusy = true;
    const prompt = vi.fn(async () => {
      if (shouldFailBusy) {
        shouldFailBusy = false;
        throw new Error(
          "Agent is already processing a prompt. Use steer() or followUp() to queue messages, or wait for completion.",
        );
      }
    });
    const waitForIdle = vi.fn(async () => {});
    const updateSessionContext = vi.fn(() => {});
    const setSessionModel = vi.fn(() => {});

    const agent = {
      prompt,
      waitForIdle,
      messages: [{ role: "assistant", content: "ok" }],
    };

    const h = handler as unknown as {
      runPromptWithFallback: (params: {
        sessionKey: string;
        agentId: string;
        text: string;
      }) => Promise<void>;
      agentManager: {
        getAgentFallbacks: (agentId: string) => string[];
        getAgent: (
          sessionKey: string,
          agentId: string,
        ) => Promise<{ agent: typeof agent; modelRef: string }>;
        updateSessionContext: (sessionKey: string, messages: unknown) => void;
        setSessionModel: SetSessionModelFn;
        clearRuntimeModelOverride: (sessionKey: string) => void;
        getContextUsage: (sessionKey: string) => unknown;
        resolvePromptTimeoutMs: (agentId: string) => number;
      };
    };

    h.agentManager = {
      getAgentFallbacks: () => ["quotio/fallback-model"],
      getAgent: async () => ({
        agent,
        modelRef: "quotio/gemini-3-flash-preview",
      }),
      updateSessionContext,
      setSessionModel,
      clearRuntimeModelOverride: vi.fn(),
      getContextUsage: () => null,
      resolvePromptTimeoutMs: () => 300_000,
    };

    await h.runPromptWithFallback({
      sessionKey: "s1",
      agentId: "mozi",
      text: "hello",
    });

    expect(prompt).toHaveBeenCalledTimes(2);
    expect(setSessionModel).not.toHaveBeenCalled();
    expect(updateSessionContext).toHaveBeenCalledTimes(1);
  });

  it("switches to fallback model on real model error", async () => {
    const handler = new MessageHandler(createConfig());

    const primaryPrompt = vi.fn(async () => {
      throw new Error("400 model failure");
    });
    const fallbackPrompt = vi.fn(async () => {});
    const updateSessionContext = vi.fn(() => {});

    const primaryAgent = {
      prompt: primaryPrompt,
      waitForIdle: vi.fn(async () => {}),
      messages: [] as Array<{ role: string; content: string }>,
    };
    const fallbackAgent = {
      prompt: fallbackPrompt,
      waitForIdle: vi.fn(async () => {}),
      messages: [{ role: "assistant", content: "ok" }],
    };

    let activeModel = "quotio/gemini-3-flash-preview";

    const h = handler as unknown as {
      runPromptWithFallback: (params: {
        sessionKey: string;
        agentId: string;
        text: string;
      }) => Promise<void>;
      agentManager: {
        getAgentFallbacks: (agentId: string) => string[];
        getAgent: (
          sessionKey: string,
          agentId: string,
        ) => Promise<{
          agent: typeof primaryAgent | typeof fallbackAgent;
          modelRef: string;
        }>;
        updateSessionContext: (sessionKey: string, messages: unknown) => void;
        setSessionModel: SetSessionModelFn;
        clearRuntimeModelOverride: (sessionKey: string) => void;
        getContextUsage: (sessionKey: string) => unknown;
        resolvePromptTimeoutMs: (agentId: string) => number;
      };
    };

    h.agentManager = {
      getAgentFallbacks: () => ["quotio/fallback-model"],
      getAgent: async () => ({
        agent: activeModel === "quotio/gemini-3-flash-preview" ? primaryAgent : fallbackAgent,
        modelRef: activeModel,
      }),
      updateSessionContext,
      setSessionModel: (_sessionKey, modelRef) => {
        activeModel = modelRef;
      },
      clearRuntimeModelOverride: vi.fn(),
      getContextUsage: () => null,
      resolvePromptTimeoutMs: () => 300_000,
    };

    await h.runPromptWithFallback({
      sessionKey: "s1",
      agentId: "mozi",
      text: "hello",
    });

    expect(primaryPrompt).toHaveBeenCalledTimes(1);
    expect(fallbackPrompt).toHaveBeenCalledTimes(1);
    expect(activeModel).toBe("quotio/fallback-model");
    expect(updateSessionContext).toHaveBeenCalledTimes(1);
  });

  it("does not treat plain aborted message as user abort", async () => {
    const handler = new MessageHandler(createConfig());

    const primaryPrompt = vi.fn(async () => {
      throw new Error("request aborted by upstream gateway");
    });
    const fallbackPrompt = vi.fn(async () => {});
    const updateSessionContext = vi.fn(() => {});

    const primaryAgent = {
      prompt: primaryPrompt,
      waitForIdle: vi.fn(async () => {}),
      messages: [] as Array<{ role: string; content: string }>,
    };
    const fallbackAgent = {
      prompt: fallbackPrompt,
      waitForIdle: vi.fn(async () => {}),
      messages: [{ role: "assistant", content: "ok" }],
    };

    let activeModel = "quotio/gemini-3-flash-preview";

    const h = handler as unknown as {
      runPromptWithFallback: (params: {
        sessionKey: string;
        agentId: string;
        text: string;
      }) => Promise<void>;
      agentManager: {
        getAgentFallbacks: (agentId: string) => string[];
        getAgent: (
          sessionKey: string,
          agentId: string,
        ) => Promise<{
          agent: typeof primaryAgent | typeof fallbackAgent;
          modelRef: string;
        }>;
        updateSessionContext: (sessionKey: string, messages: unknown) => void;
        setSessionModel: SetSessionModelFn;
        clearRuntimeModelOverride: (sessionKey: string) => void;
        getContextUsage: (sessionKey: string) => unknown;
        resolvePromptTimeoutMs: (agentId: string) => number;
      };
    };

    h.agentManager = {
      getAgentFallbacks: () => ["quotio/fallback-model"],
      getAgent: async () => ({
        agent: activeModel === "quotio/gemini-3-flash-preview" ? primaryAgent : fallbackAgent,
        modelRef: activeModel,
      }),
      updateSessionContext,
      setSessionModel: (_sessionKey, modelRef) => {
        activeModel = modelRef;
      },
      clearRuntimeModelOverride: vi.fn(),
      getContextUsage: () => null,
      resolvePromptTimeoutMs: () => 300_000,
    };

    await h.runPromptWithFallback({
      sessionKey: "s1",
      agentId: "mozi",
      text: "hello",
    });

    expect(primaryPrompt).toHaveBeenCalledTimes(1);
    expect(fallbackPrompt).toHaveBeenCalledTimes(1);
    expect(activeModel).toBe("quotio/fallback-model");
    expect(updateSessionContext).toHaveBeenCalledTimes(1);
  });

  it("switches to fallback model when prompt times out", async () => {
    const handler = new MessageHandler(createConfig());

    const primaryPrompt = vi.fn(async () => {
      await new Promise(() => {});
    });
    const fallbackPrompt = vi.fn(async () => {});
    const updateSessionContext = vi.fn(() => {});

    const primaryAgent = {
      prompt: primaryPrompt,
      waitForIdle: vi.fn(async () => {}),
      messages: [] as Array<{ role: string; content: string }>,
    };
    const fallbackAgent = {
      prompt: fallbackPrompt,
      waitForIdle: vi.fn(async () => {}),
      messages: [{ role: "assistant", content: "ok" }],
    };

    let activeModel = "quotio/gemini-3-flash-preview";

    const h = handler as unknown as {
      runPromptWithFallback: (params: {
        sessionKey: string;
        agentId: string;
        text: string;
      }) => Promise<void>;
      agentManager: {
        getAgentFallbacks: (agentId: string) => string[];
        getAgent: (
          sessionKey: string,
          agentId: string,
        ) => Promise<{
          agent: typeof primaryAgent | typeof fallbackAgent;
          modelRef: string;
        }>;
        updateSessionContext: (sessionKey: string, messages: unknown) => void;
        setSessionModel: SetSessionModelFn;
        clearRuntimeModelOverride: (sessionKey: string) => void;
        getContextUsage: (sessionKey: string) => unknown;
        resolvePromptTimeoutMs: (agentId: string) => number;
      };
    };

    h.agentManager = {
      getAgentFallbacks: () => ["quotio/fallback-model"],
      getAgent: async () => ({
        agent: activeModel === "quotio/gemini-3-flash-preview" ? primaryAgent : fallbackAgent,
        modelRef: activeModel,
      }),
      updateSessionContext,
      setSessionModel: (_sessionKey, modelRef) => {
        activeModel = modelRef;
      },
      clearRuntimeModelOverride: vi.fn(),
      getContextUsage: () => null,
      resolvePromptTimeoutMs: () => 100,
    };

    vi.useFakeTimers();
    const run = h.runPromptWithFallback({
      sessionKey: "s-timeout",
      agentId: "mozi",
      text: "hello",
    });

    await vi.advanceTimersByTimeAsync(150);
    await run;
    vi.useRealTimers();

    expect(primaryPrompt).toHaveBeenCalledTimes(1);
    expect(fallbackPrompt).toHaveBeenCalledTimes(1);
    expect(activeModel).toBe("quotio/fallback-model");
    expect(updateSessionContext).toHaveBeenCalledTimes(1);
  });

  it("interruptSession aborts active run and waits for idle", async () => {
    const handler = new MessageHandler(createConfig());

    let rejectPrompt: ((error: Error) => void) | undefined;
    const prompt = vi.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectPrompt = reject;
        }),
    );
    const abort = vi.fn(() => {
      const err = new Error("aborted by interrupt");
      err.name = "AbortError";
      rejectPrompt?.(err);
    });
    const waitForIdle = vi.fn(async () => {});

    const agent = {
      prompt,
      abort,
      waitForIdle,
      messages: [] as Array<{ role: string; content: string }>,
    };

    const h = handler as unknown as {
      runPromptWithFallback: (params: {
        sessionKey: string;
        agentId: string;
        text: string;
      }) => Promise<void>;
      interruptSession: (sessionKey: string, reason?: string) => Promise<boolean>;
      agentManager: {
        getAgentFallbacks: (agentId: string) => string[];
        getAgent: (
          sessionKey: string,
          agentId: string,
        ) => Promise<{ agent: typeof agent; modelRef: string }>;
        updateSessionContext: (sessionKey: string, messages: unknown) => void;
        setSessionModel: SetSessionModelFn;
        clearRuntimeModelOverride: (sessionKey: string) => void;
        getContextUsage: (sessionKey: string) => unknown;
        resolvePromptTimeoutMs: (agentId: string) => number;
      };
    };

    h.agentManager = {
      getAgentFallbacks: () => [],
      getAgent: async () => ({
        agent,
        modelRef: "quotio/gemini-3-flash-preview",
      }),
      updateSessionContext: () => {},
      setSessionModel: () => {},
      clearRuntimeModelOverride: vi.fn(),
      getContextUsage: () => null,
      resolvePromptTimeoutMs: () => 300_000,
    };

    const running = h
      .runPromptWithFallback({
        sessionKey: "s-interrupt",
        agentId: "mozi",
        text: "hello",
      })
      .catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 10));

    const interrupted = await h.interruptSession("s-interrupt", "test interrupt");
    await running;

    expect(interrupted).toBe(true);
    expect(abort).toHaveBeenCalledTimes(1);
    const interruptedAgain = await h.interruptSession("s-interrupt", "second");
    expect(interruptedAgain).toBe(false);
  });

  it("steerSession injects message into active run", async () => {
    const handler = new MessageHandler(createConfig());

    let rejectPrompt: ((error: Error) => void) | undefined;
    const prompt = vi.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectPrompt = reject;
        }),
    );
    const steer = vi.fn(async () => {});
    const waitForIdle = vi.fn(async () => {});
    const abort = vi.fn(() => {
      const err = new Error("aborted by test");
      err.name = "AbortError";
      rejectPrompt?.(err);
    });
    const agent = {
      prompt,
      steer,
      waitForIdle,
      abort,
      messages: [] as Array<{ role: string; content: string }>,
    };

    const h = handler as unknown as {
      runPromptWithFallback: (params: {
        sessionKey: string;
        agentId: string;
        text: string;
      }) => Promise<void>;
      steerSession: (
        sessionKey: string,
        text: string,
        mode?: "steer" | "followup",
      ) => Promise<boolean>;
      interruptSession: (sessionKey: string, reason?: string) => Promise<boolean>;
      agentManager: {
        getAgentFallbacks: (agentId: string) => string[];
        getAgent: (
          sessionKey: string,
          agentId: string,
        ) => Promise<{ agent: typeof agent; modelRef: string }>;
        updateSessionContext: (sessionKey: string, messages: unknown) => void;
        setSessionModel: SetSessionModelFn;
        clearRuntimeModelOverride: (sessionKey: string) => void;
        getContextUsage: (sessionKey: string) => unknown;
        resolvePromptTimeoutMs: (agentId: string) => number;
      };
    };

    h.agentManager = {
      getAgentFallbacks: () => [],
      getAgent: async () => ({
        agent,
        modelRef: "quotio/gemini-3-flash-preview",
      }),
      updateSessionContext: () => {},
      setSessionModel: () => {},
      clearRuntimeModelOverride: vi.fn(),
      getContextUsage: () => null,
      resolvePromptTimeoutMs: () => 300_000,
    };

    const running = h
      .runPromptWithFallback({
        sessionKey: "s-steer",
        agentId: "mozi",
        text: "hello",
      })
      .catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 10));

    const injected = await h.steerSession("s-steer", "please continue", "steer");
    const injectedEmpty = await h.steerSession("s-steer", "   ", "steer");
    await h.interruptSession("s-steer", "cleanup");
    await running;

    expect(injected).toBe(true);
    expect(injectedEmpty).toBe(false);
    expect(steer).toHaveBeenCalledTimes(1);
  });

  it("steerSession can fallback to followUp when steer is unavailable", async () => {
    const handler = new MessageHandler(createConfig());

    let rejectPrompt: ((error: Error) => void) | undefined;
    const prompt = vi.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectPrompt = reject;
        }),
    );
    const followUp = vi.fn(async () => {});
    const waitForIdle = vi.fn(async () => {});
    const abort = vi.fn(() => {
      const err = new Error("aborted by test");
      err.name = "AbortError";
      rejectPrompt?.(err);
    });
    const agent = {
      prompt,
      followUp,
      waitForIdle,
      abort,
      messages: [] as Array<{ role: string; content: string }>,
    };

    const h = handler as unknown as {
      runPromptWithFallback: (params: {
        sessionKey: string;
        agentId: string;
        text: string;
      }) => Promise<void>;
      steerSession: (
        sessionKey: string,
        text: string,
        mode?: "steer" | "followup",
      ) => Promise<boolean>;
      interruptSession: (sessionKey: string, reason?: string) => Promise<boolean>;
      agentManager: {
        getAgentFallbacks: (agentId: string) => string[];
        getAgent: (
          sessionKey: string,
          agentId: string,
        ) => Promise<{ agent: typeof agent; modelRef: string }>;
        updateSessionContext: (sessionKey: string, messages: unknown) => void;
        setSessionModel: SetSessionModelFn;
        clearRuntimeModelOverride: (sessionKey: string) => void;
        getContextUsage: (sessionKey: string) => unknown;
        resolvePromptTimeoutMs: (agentId: string) => number;
      };
    };

    h.agentManager = {
      getAgentFallbacks: () => [],
      getAgent: async () => ({
        agent,
        modelRef: "quotio/gemini-3-flash-preview",
      }),
      updateSessionContext: () => {},
      setSessionModel: () => {},
      clearRuntimeModelOverride: vi.fn(),
      getContextUsage: () => null,
      resolvePromptTimeoutMs: () => 300_000,
    };

    const running = h
      .runPromptWithFallback({
        sessionKey: "s-followup",
        agentId: "mozi",
        text: "hello",
      })
      .catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 10));

    const injectedFollowup = await h.steerSession("s-followup", "queue this", "followup");
    const injectedSteerFallback = await h.steerSession("s-followup", "still inject", "steer");
    await h.interruptSession("s-followup", "cleanup");
    await running;

    expect(injectedFollowup).toBe(true);
    expect(injectedSteerFallback).toBe(true);
    expect(followUp).toHaveBeenCalledTimes(2);
  });
});
