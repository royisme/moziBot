import { TUI, ProcessTerminal, Text, Input, Container } from "@mariozechner/pi-tui";
import { loadConfig } from "../config";
import { BaseChannelPlugin } from "../runtime/adapters/channels/plugin";
import type { OutboundMessage, InboundMessage } from "../runtime/adapters/channels/types";
import { MessageHandler } from "../runtime/host/message-handler";
import { bootstrapSandboxes } from "../runtime/sandbox/bootstrap";
import { LocalDesktopRuntimeClient } from "./runtime-client";

type ChatOptions = {
  runtime?: boolean;
  host?: string;
  port?: number | string;
  token?: string;
  peerId?: string;
  config?: string;
};

class LocalChannel extends BaseChannelPlugin {
  readonly id = "tui";
  readonly name = "TUI";

  constructor(private onSend: (msg: OutboundMessage) => void) {
    super();
  }

  async connect(): Promise<void> {
    this.setStatus("connected");
  }

  async disconnect(): Promise<void> {
    this.setStatus("disconnected");
  }

  async send(_peerId: string, message: OutboundMessage): Promise<string> {
    this.onSend(message);
    return `${Date.now()}`;
  }
}

export async function runChat(options: ChatOptions = {}) {
  const mode = options.runtime ? "runtime" : "direct";
  const configResult = loadConfig(options.config);

  if (!configResult.success || !configResult.config) {
    if (mode === "direct") {
      console.error("Failed to load config:", configResult.errors?.join("; ") || "unknown error");
      process.exit(1);
    } else {
      console.warn(
        "Runtime chat: config not loaded, falling back to CLI/default runtime settings.",
      );
    }
  }

  if (mode === "direct" && configResult.config) {
    const bootstrap = await bootstrapSandboxes(configResult.config, {
      fix: true,
      onlyAutoEnabled: true,
    });
    if (bootstrap.attempted > 0) {
      for (const action of bootstrap.actions) {
        console.log(`[sandbox bootstrap][${action.agentId}] ${action.message}`);
      }
      for (const issue of bootstrap.issues) {
        const prefix = issue.level === "error" ? "ERROR" : "WARN";
        console.error(`[sandbox bootstrap][${prefix}][${issue.agentId}] ${issue.message}`);
        for (const hint of issue.hints) {
          console.error(`  hint: ${hint}`);
        }
      }
    }
    if (!bootstrap.ok) {
      process.exit(1);
    }
  }
  const terminal = new ProcessTerminal();
  const tui = new TUI(terminal);

  const messages: Array<{ role: string; text: string }> = [];
  const log = new Text("", 1, 1);
  const input = new Input();

  const renderLog = () => {
    const content = messages.map((m) => `${m.role}: ${m.text}`).join("\n\n");
    log.setText(content);
    tui.requestRender();
  };

  const pushAssistantMessage = (text: string) => {
    messages.push({ role: "Mozi", text });
    renderLog();
  };

  if (mode === "direct") {
    const handler = new MessageHandler(configResult.config!);
    const channel = new LocalChannel((msg) => {
      const text = msg.text || "";
      pushAssistantMessage(text);
    });
    await channel.connect();

    input.onSubmit = async (value) => {
      const text = value.trim();
      if (!text) {
        return;
      }
      input.setValue("");
      messages.push({ role: "User", text });
      renderLog();

      const inbound: InboundMessage = {
        id: `${Date.now()}`,
        channel: channel.id,
        peerId: "local",
        peerType: "dm",
        senderId: "local",
        senderName: "User",
        text,
        timestamp: new Date(),
        raw: { source: "tui" },
      };

      try {
        await handler.handle(inbound, channel);
      } catch {
        // MessageHandler already sent a user-facing error message through channel.send.
      }
    };
  } else {
    const config = configResult.config;
    const host = options.host ?? config?.channels?.localDesktop?.host ?? "127.0.0.1";
    const fallbackPort = config?.channels?.localDesktop?.port ?? 3987;
    const resolvedPort = resolvePort(options.port, fallbackPort);
    const authToken = options.token ?? config?.channels?.localDesktop?.authToken;
    const peerId = options.peerId ?? "desktop-default";

    if (!resolvedPort) {
      console.error("Invalid runtime port. Provide --port or set channels.localDesktop.port.");
      process.exit(1);
    }

    const client = new LocalDesktopRuntimeClient({
      host,
      port: resolvedPort,
      authToken,
      peerId,
    });

    client.onAssistantMessage = (message) => {
      pushAssistantMessage(message.text);
    };

    try {
      await client.connect();
      await client.waitForReady();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Runtime chat failed to connect: ${message}`);
      process.exit(1);
    }

    input.onSubmit = async (value) => {
      const text = value.trim();
      if (!text) {
        return;
      }
      input.setValue("");
      messages.push({ role: "User", text });
      renderLog();

      try {
        await client.sendText(text);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        messages.push({ role: "System", text: `Send failed: ${message}` });
        renderLog();
      }
    };
  }

  const container = new Container();
  container.addChild(log);
  container.addChild(input);

  tui.addChild(container);
  tui.start();
}

function resolvePort(value: unknown, fallback: number): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  if (Number.isFinite(fallback)) {
    return fallback;
  }
  return null;
}
