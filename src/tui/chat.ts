import { TUI, ProcessTerminal, Text, Input, Container } from "@mariozechner/pi-tui";
import type { OutboundMessage, InboundMessage } from "../runtime/adapters/channels/types";
import { loadConfig } from "../config";
import { BaseChannelPlugin } from "../runtime/adapters/channels/plugin";
import { MessageHandler } from "../runtime/host/message-handler";
import { bootstrapSandboxes } from "../runtime/sandbox/bootstrap";

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

export async function runChat() {
  const result = loadConfig();
  if (!result.success || !result.config) {
    console.error("Failed to load config:", result.errors?.join("; ") || "unknown error");
    process.exit(1);
  }

  const bootstrap = await bootstrapSandboxes(result.config, {
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

  const handler = new MessageHandler(result.config);
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

  const channel = new LocalChannel((msg) => {
    const text = msg.text || "";
    messages.push({ role: "Mozi", text });
    renderLog();
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

  const container = new Container();
  container.addChild(log);
  container.addChild(input);

  tui.addChild(container);
  tui.start();
}
