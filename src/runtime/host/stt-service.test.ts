import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MoziConfig } from "../../config";
import type { InboundMessage } from "../adapters/channels/types";
import { SttService } from "./stt-service";

const mocks = vi.hoisted(() => ({
  execaMock: vi.fn(),
  accessMock: vi.fn(async () => {}),
  mkdtempMock: vi.fn(async () => "/tmp/mozi-stt-test"),
  writeFileMock: vi.fn(async () => {}),
  readFileMock: vi.fn(async () => Buffer.from("audio")),
  rmMock: vi.fn(async () => {}),
}));

vi.mock("execa", () => ({
  execa: mocks.execaMock,
}));

vi.mock("node:fs/promises", () => ({
  access: mocks.accessMock,
  mkdtemp: mocks.mkdtempMock,
  writeFile: mocks.writeFileMock,
  readFile: mocks.readFileMock,
  rm: mocks.rmMock,
}));

function createMessage(): InboundMessage {
  return {
    id: "m-voice-1",
    channel: "telegram",
    peerId: "chat-1",
    peerType: "dm",
    senderId: "u-1",
    text: "",
    media: [
      {
        type: "voice",
        buffer: Buffer.from("abc"),
        mimeType: "audio/ogg",
      },
    ],
    timestamp: new Date(),
    raw: {},
  };
}

function createConfig(strategy: "local-only" | "remote-only" | "local-first"): MoziConfig {
  return {
    voice: {
      stt: {
        strategy,
        local: {
          provider: "whisper.cpp",
          binPath: "whisper-cli",
          modelPath: "/models/ggml-large-v3-turbo.bin",
          language: "zh",
          timeoutMs: 5000,
        },
        remote: {
          provider: "openai",
          model: "whisper-1",
          endpoint: "https://example.invalid/stt",
          apiKey: "test-key",
          timeoutMs: 5000,
        },
      },
    },
  };
}

describe("SttService", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    mocks.execaMock.mockReset();
    mocks.accessMock.mockClear();
    mocks.mkdtempMock.mockClear();
    mocks.writeFileMock.mockClear();
    mocks.readFileMock.mockClear();
    mocks.rmMock.mockClear();
    globalThis.fetch = vi.fn() as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("uses local whisper.cpp in local-only mode", async () => {
    mocks.execaMock.mockResolvedValue({ stdout: "hello from whisper" });
    const service = new SttService(createConfig("local-only"));

    const transcript = await service.transcribeInboundMessage(createMessage());

    expect(transcript).toBe("hello from whisper");
    expect(mocks.execaMock).toHaveBeenCalledTimes(1);
    expect(mocks.execaMock.mock.calls[0]?.[0]).toBe("whisper-cli");
  });

  it("falls back to remote in local-first mode", async () => {
    mocks.execaMock.mockRejectedValue(new Error("local failed"));
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ text: "remote transcript" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const service = new SttService(createConfig("local-first"));
    const transcript = await service.transcribeInboundMessage(createMessage());

    expect(transcript).toBe("remote transcript");
    expect(fetchMock).toHaveBeenCalled();
  });

  it("returns null when no audio media", async () => {
    const service = new SttService(createConfig("local-first"));
    const transcript = await service.transcribeInboundMessage({
      id: "m-1",
      channel: "telegram",
      peerId: "chat-1",
      peerType: "dm",
      senderId: "u-1",
      text: "hello",
      timestamp: new Date(),
      raw: {},
    });

    expect(transcript).toBeNull();
  });
});
