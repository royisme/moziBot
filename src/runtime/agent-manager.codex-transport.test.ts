import type {
  AssistantMessageEventStream,
  Context,
  Model,
  StreamOptions,
} from "@mariozechner/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { createCodexDefaultTransportWrapper } from "./agent-manager";

describe("createCodexDefaultTransportWrapper", () => {
  function makeModel(): Model<"openai-codex-responses"> {
    return {
      id: "codex-mini-latest",
      name: "Codex Mini",
      api: "openai-codex-responses",
      provider: "openai-codex",
      baseUrl: "https://chatgpt.com/backend-api",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: 8192,
    };
  }

  function makeContext(): Context {
    return { messages: [] };
  }

  function makeMockStream(): AssistantMessageEventStream {
    return {} as AssistantMessageEventStream;
  }

  it("defaults to transport: auto when no transport is set", () => {
    const capturedOptions: (StreamOptions | undefined)[] = [];
    const base = vi.fn(
      (
        _model: Model<"openai-codex-responses">,
        _context: Context,
        options?: StreamOptions,
      ): AssistantMessageEventStream => {
        capturedOptions.push(options);
        return makeMockStream();
      },
    );

    const wrapped = createCodexDefaultTransportWrapper(base);
    wrapped(makeModel(), makeContext(), {});

    expect(capturedOptions).toHaveLength(1);
    expect(capturedOptions[0]?.transport).toBe("auto");
  });

  it("preserves explicitly set transport value", () => {
    const capturedOptions: (StreamOptions | undefined)[] = [];
    const base = vi.fn(
      (
        _model: Model<"openai-codex-responses">,
        _context: Context,
        options?: StreamOptions,
      ): AssistantMessageEventStream => {
        capturedOptions.push(options);
        return makeMockStream();
      },
    );

    const wrapped = createCodexDefaultTransportWrapper(base);
    wrapped(makeModel(), makeContext(), { transport: "sse" });

    expect(capturedOptions).toHaveLength(1);
    expect(capturedOptions[0]?.transport).toBe("sse");
  });

  it("preserves explicitly set websocket transport", () => {
    const capturedOptions: (StreamOptions | undefined)[] = [];
    const base = vi.fn(
      (
        _model: Model<"openai-codex-responses">,
        _context: Context,
        options?: StreamOptions,
      ): AssistantMessageEventStream => {
        capturedOptions.push(options);
        return makeMockStream();
      },
    );

    const wrapped = createCodexDefaultTransportWrapper(base);
    wrapped(makeModel(), makeContext(), { transport: "websocket" });

    expect(capturedOptions).toHaveLength(1);
    expect(capturedOptions[0]?.transport).toBe("websocket");
  });

  it("defaults to transport: auto when options is undefined", () => {
    const capturedOptions: (StreamOptions | undefined)[] = [];
    const base = vi.fn(
      (
        _model: Model<"openai-codex-responses">,
        _context: Context,
        options?: StreamOptions,
      ): AssistantMessageEventStream => {
        capturedOptions.push(options);
        return makeMockStream();
      },
    );

    const wrapped = createCodexDefaultTransportWrapper(base);
    wrapped(makeModel(), makeContext(), undefined);

    expect(capturedOptions).toHaveLength(1);
    expect(capturedOptions[0]?.transport).toBe("auto");
  });

  it("preserves other options alongside transport default", () => {
    const capturedOptions: (StreamOptions | undefined)[] = [];
    const base = vi.fn(
      (
        _model: Model<"openai-codex-responses">,
        _context: Context,
        options?: StreamOptions,
      ): AssistantMessageEventStream => {
        capturedOptions.push(options);
        return makeMockStream();
      },
    );

    const wrapped = createCodexDefaultTransportWrapper(base);
    wrapped(makeModel(), makeContext(), { temperature: 0.5, maxTokens: 1024 });

    expect(capturedOptions).toHaveLength(1);
    expect(capturedOptions[0]?.transport).toBe("auto");
    expect(capturedOptions[0]?.temperature).toBe(0.5);
    expect(capturedOptions[0]?.maxTokens).toBe(1024);
  });

  it("forwards model and context to underlying function", () => {
    const capturedModels: Model<"openai-codex-responses">[] = [];
    const capturedContexts: Context[] = [];
    const base = vi.fn(
      (
        model: Model<"openai-codex-responses">,
        context: Context,
        _options?: StreamOptions,
      ): AssistantMessageEventStream => {
        capturedModels.push(model);
        capturedContexts.push(context);
        return makeMockStream();
      },
    );

    const model = makeModel();
    const context = makeContext();
    const wrapped = createCodexDefaultTransportWrapper(base);
    wrapped(model, context);

    expect(capturedModels[0]).toBe(model);
    expect(capturedContexts[0]).toBe(context);
  });

  it("uses streamSimple as default when no base function is provided", () => {
    const wrapped = createCodexDefaultTransportWrapper();
    expect(typeof wrapped).toBe("function");
  });
});
