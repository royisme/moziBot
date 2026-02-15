import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { LocalDesktopPlugin } from "./plugin";

const mocks = vi.hoisted(() => ({
  transcribeInboundMessageMock: vi.fn(),
  textToSpeechMock: vi.fn(),
}));

vi.mock("../../../media-understanding/stt-service", () => ({
  SttService: class {
    transcribeInboundMessage = (...args: unknown[]) => mocks.transcribeInboundMessageMock(...args);
  },
}));

vi.mock("../../../tts/tts-service", () => ({
  TtsService: class {
    textToSpeech = (...args: unknown[]) => mocks.textToSpeechMock(...args);
  },
}));

type StreamReaderLike = {
  read: () => Promise<{ value?: Uint8Array }>;
};

async function readSseEvent(reader: StreamReaderLike): Promise<string> {
  const decoder = new TextDecoder();
  const { value } = await reader.read();
  return decoder.decode(value ?? new Uint8Array());
}

async function readSseUntilContains(
  reader: StreamReaderLike,
  needles: string[],
  timeoutMs = 3000,
): Promise<string> {
  const started = Date.now();
  let combined = "";

  while (Date.now() - started < timeoutMs) {
    const chunk = await Promise.race<string>([
      readSseEvent(reader),
      new Promise<string>((_, reject) => {
        setTimeout(() => reject(new Error("SSE read timeout")), 500);
      }),
    ]);
    combined += `\n${chunk}`;
    if (needles.every((needle) => combined.includes(needle))) {
      return combined;
    }
  }

  throw new Error(`Did not receive expected SSE content: ${needles.join(", ")}`);
}

async function connectAudioWs(url: string, timeoutMs = 3000): Promise<WebSocket> {
  return await new Promise<WebSocket>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`WebSocket connect timeout: ${url}`));
    }, timeoutMs);
    const ws = new WebSocket(url);
    ws.once("open", () => {
      clearTimeout(timer);
      resolve(ws);
    });
    ws.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    ws.once("unexpected-response", () => {
      clearTimeout(timer);
      reject(new Error("WebSocket unexpected response"));
    });
    ws.once("close", (code) => {
      clearTimeout(timer);
      if (code !== 1000) {
        reject(new Error(`WebSocket closed before open: ${code}`));
      }
    });
  });
}

async function waitForWsMessage(ws: WebSocket, timeoutMs = 3000): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("WebSocket message timeout"));
    }, timeoutMs);

    ws.once("message", (raw) => {
      clearTimeout(timer);
      resolve(raw.toString("utf8"));
    });

    ws.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function waitForWsMessageType(
  ws: WebSocket,
  expectedType: string,
  timeoutMs = 3000,
): Promise<string> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const message = await waitForWsMessage(ws, timeoutMs);
    if (message.includes(`"type":"${expectedType}"`)) {
      return message;
    }
  }
  throw new Error(`WebSocket message type timeout: ${expectedType}`);
}

async function waitForWsMessagesAfter(
  ws: WebSocket,
  expectedTypes: string[],
  trigger: () => Promise<void> | void,
  timeoutMs = 3000,
): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    let combined = "";
    const timer = setTimeout(() => {
      ws.off("message", onMessage);
      reject(new Error(`WebSocket message types timeout: ${expectedTypes.join(",")}`));
    }, timeoutMs);

    const onMessage = (raw: WebSocket.RawData) => {
      const message = raw.toString("utf8");
      combined += `\n${message}`;
      if (expectedTypes.every((type) => combined.includes(`"type":"${type}"`))) {
        clearTimeout(timer);
        ws.off("message", onMessage);
        resolve(combined);
      }
    };

    ws.on("message", onMessage);

    Promise.resolve(trigger()).catch((error) => {
      clearTimeout(timer);
      ws.off("message", onMessage);
      reject(error);
    });
  });
}

describe("LocalDesktopPlugin", () => {
  const plugins: LocalDesktopPlugin[] = [];

  beforeEach(() => {
    mocks.transcribeInboundMessageMock.mockReset();
    mocks.transcribeInboundMessageMock.mockResolvedValue(null);
    mocks.textToSpeechMock.mockReset();
    mocks.textToSpeechMock.mockResolvedValue({
      provider: "edge",
      mimeType: "audio/mpeg",
      buffer: Buffer.from("fake-audio-buffer"),
      durationMs: 1200,
      voice: "en-US-AriaNeural",
    });
  });

  afterEach(async () => {
    await Promise.all(
      plugins.map(async (plugin) => {
        await plugin.disconnect();
      }),
    );
    plugins.length = 0;
  });

  it("accepts inbound message via HTTP endpoint", async () => {
    const plugin = new LocalDesktopPlugin({ host: "127.0.0.1", port: 0 });
    plugins.push(plugin);
    await plugin.connect();
    const port = plugin.getPort();
    expect(typeof port).toBe("number");

    const received = new Promise<{ text: string }>((resolve) => {
      plugin.once("message", (msg) => resolve({ text: msg.text }));
    });

    const response = await fetch(`http://127.0.0.1:${port}/inbound`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "hello local" }),
    });

    expect(response.status).toBe(202);
    await expect(received).resolves.toEqual({ text: "hello local" });
  });

  it("streams assistant messages and phases over SSE", async () => {
    const plugin = new LocalDesktopPlugin({ host: "127.0.0.1", port: 0 });
    plugins.push(plugin);
    await plugin.connect();
    const port = plugin.getPort();

    const response = await fetch(`http://127.0.0.1:${port}/events?peerId=desktop-default`);
    expect(response.ok).toBe(true);
    const reader = response.body?.getReader();
    expect(reader).toBeDefined();
    if (!reader) {
      return;
    }

    await plugin.emitPhase("desktop-default", "thinking", { sessionKey: "s1" });
    await plugin.send("desktop-default", { text: "reply from runtime" });

    const chunk1 = await readSseEvent(reader);
    const chunk2 = await readSseEvent(reader);
    const combined = `${chunk1}\n${chunk2}`;

    expect(combined).toContain("thinking");
    expect(combined).toContain("reply from runtime");
  });

  it("accepts SSE auth token via query parameter", async () => {
    const plugin = new LocalDesktopPlugin({ host: "127.0.0.1", port: 0, authToken: "local-token" });
    plugins.push(plugin);
    await plugin.connect();
    const port = plugin.getPort();

    const unauthorized = await fetch(`http://127.0.0.1:${port}/events?peerId=desktop-default`);
    expect(unauthorized.status).toBe(401);

    const authorized = await fetch(
      `http://127.0.0.1:${port}/events?peerId=desktop-default&token=local-token`,
    );
    expect(authorized.ok).toBe(true);
  });

  it("exposes widget config endpoint without auth", async () => {
    const plugin = new LocalDesktopPlugin({ host: "127.0.0.1", port: 0, authToken: "local-token" });
    plugins.push(plugin);
    await plugin.connect();
    const port = plugin.getPort();

    const response = await fetch(`http://127.0.0.1:${port}/widget-config`);
    expect(response.ok).toBe(true);
    const json = (await response.json()) as {
      enabled: boolean;
      host: string;
      port: number;
      peerId: string;
      authToken?: string;
    };
    expect(json.enabled).toBe(true);
    expect(json.host).toBe("127.0.0.1");
    expect(json.peerId).toBe("desktop-default");
    expect(json.authToken).toBe("local-token");
  });

  it("rejects unauthorized websocket audio upgrade", async () => {
    const plugin = new LocalDesktopPlugin({ host: "127.0.0.1", port: 0, authToken: "local-token" });
    plugins.push(plugin);
    await plugin.connect();
    const port = plugin.getPort();

    await expect(connectAudioWs(`ws://127.0.0.1:${port}/audio?peerId=desktop-default`)).rejects.toThrow();
  });

  it("accepts authorized websocket audio upgrade and replies pong", async () => {
    const plugin = new LocalDesktopPlugin({ host: "127.0.0.1", port: 0, authToken: "local-token" });
    plugins.push(plugin);
    await plugin.connect();
    const port = plugin.getPort();

    const ws = await connectAudioWs(
      `ws://127.0.0.1:${port}/audio?peerId=desktop-default&token=local-token`,
    );

    ws.send(JSON.stringify({ type: "ping", ts: 123 }));
    const pongMessage = await waitForWsMessageType(ws, "pong");
    expect(pongMessage).toContain('"type":"pong"');
    expect(pongMessage).toContain('"ts":123');

    ws.close();
  });

  it("transcribes audio_commit and emits transcript event plus inbound message", async () => {
    mocks.transcribeInboundMessageMock.mockResolvedValue("hello from speech");

    const plugin = new LocalDesktopPlugin({ host: "127.0.0.1", port: 0 });
    plugins.push(plugin);
    await plugin.connect();
    const port = plugin.getPort();

    const sse = await fetch(`http://127.0.0.1:${port}/events?peerId=desktop-default`);
    const reader = sse.body?.getReader();
    expect(reader).toBeDefined();
    if (!reader) {
      return;
    }

    const received = new Promise<{ text: string }>((resolve) => {
      plugin.once("message", (msg) => resolve({ text: msg.text }));
    });

    const ws = await connectAudioWs(`ws://127.0.0.1:${port}/audio?peerId=desktop-default`);
    ws.send(
      JSON.stringify({
        type: "audio_chunk",
        streamId: "s1",
        seq: 0,
        sampleRate: 16000,
        channels: 1,
        encoding: "pcm_s16le",
        chunkBase64: Buffer.from([1, 2, 3, 4]).toString("base64"),
      }),
    );
    ws.send(JSON.stringify({ type: "audio_commit", streamId: "s1" }));

    await expect(received).resolves.toEqual({ text: "hello from speech" });

    const combined = await readSseUntilContains(reader, [
      '"type":"phase"',
      '"listening"',
      '"type":"transcript"',
      "hello from speech",
    ]);
    expect(combined).toContain('"type":"phase"');
    expect(combined).toContain('"listening"');
    expect(combined).toContain('"type":"transcript"');
    expect(combined).toContain("hello from speech");

    ws.close();
  });

  it("synthesizes assistant text and streams audio over websocket", async () => {
    const plugin = new LocalDesktopPlugin({ host: "127.0.0.1", port: 0 });
    plugins.push(plugin);
    await plugin.connect();
    const port = plugin.getPort();

    const sse = await fetch(`http://127.0.0.1:${port}/events?peerId=desktop-default`);
    const reader = sse.body?.getReader();
    expect(reader).toBeDefined();
    if (!reader) {
      return;
    }

    const ws = await connectAudioWs(`ws://127.0.0.1:${port}/audio?peerId=desktop-default`);
    const audioMessages = await waitForWsMessagesAfter(ws, ["audio_meta", "audio_chunk"], async () => {
      await plugin.send("desktop-default", { text: "assistant says hello" });
    });
    expect(audioMessages).toContain('"type":"audio_meta"');
    expect(audioMessages).toContain('"mimeType":"audio/mpeg"');
    expect(audioMessages).toContain("assistant says hello");
    expect(audioMessages).toContain('"type":"audio_chunk"');
    expect(audioMessages).toContain('"chunkBase64"');

    const sseCombined = await readSseUntilContains(reader, [
      '"type":"assistant_message"',
      '"assistant says hello"',
      '"type":"audio_ready"',
    ]);
    expect(sseCombined).toContain('"type":"audio_ready"');

    expect(mocks.textToSpeechMock).toHaveBeenCalledWith("assistant says hello", {
      peerId: "desktop-default",
    });

    ws.close();
  });
});
