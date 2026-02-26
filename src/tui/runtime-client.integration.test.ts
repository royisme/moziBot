import { afterEach, describe, expect, it } from "vitest";
import { LocalDesktopPlugin } from "../runtime/adapters/channels/local-desktop/plugin";
import { LocalDesktopRuntimeClient } from "./runtime-client";

describe("LocalDesktopRuntimeClient", () => {
  const plugins: LocalDesktopPlugin[] = [];

  afterEach(async () => {
    await Promise.all(
      plugins.map(async (plugin) => {
        await plugin.disconnect();
      }),
    );
    plugins.length = 0;
  });

  it("sends inbound text and receives assistant messages", async () => {
    const plugin = new LocalDesktopPlugin({ host: "127.0.0.1", port: 0 });
    plugins.push(plugin);
    await plugin.connect();

    const port = plugin.getPort();
    if (typeof port !== "number") {
      throw new Error("LocalDesktopPlugin did not bind to a port");
    }

    const client = new LocalDesktopRuntimeClient({
      host: "127.0.0.1",
      port,
      peerId: "desktop-default",
    });

    const assistantMessage = new Promise<string>((resolve) => {
      client.onAssistantMessage = (message) => resolve(message.text);
    });

    await client.connect();
    await client.waitForReady();

    await plugin.send("desktop-default", { text: "hello runtime client" });
    await expect(assistantMessage).resolves.toBe("hello runtime client");

    const inboundMessage = new Promise<string>((resolve) => {
      plugin.once("message", (message) => resolve(message.text));
    });

    await client.sendText("hello from client");
    await expect(inboundMessage).resolves.toBe("hello from client");

    await client.disconnect();
  });
});
