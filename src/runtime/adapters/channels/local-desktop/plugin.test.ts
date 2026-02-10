import { afterEach, describe, expect, it } from "vitest";
import { LocalDesktopPlugin } from "./plugin";

type StreamReaderLike = {
  read: () => Promise<{ value?: Uint8Array }>;
};

async function readSseEvent(reader: StreamReaderLike): Promise<string> {
  const decoder = new TextDecoder();
  const { value } = await reader.read();
  return decoder.decode(value ?? new Uint8Array());
}

describe("LocalDesktopPlugin", () => {
  const plugins: LocalDesktopPlugin[] = [];

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
});
