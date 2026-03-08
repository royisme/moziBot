import { randomUUID } from "node:crypto";

export type LocalDesktopRuntimeClientOptions = {
  host: string;
  port: number;
  authToken?: string;
  peerId?: string;
  peerType?: "dm" | "group" | "channel";
  senderId?: string;
  senderName?: string;
};

export type LocalDesktopRuntimeEvent = {
  type: string;
  [key: string]: unknown;
};

export type LocalDesktopAssistantMessage = {
  text: string;
  media?: unknown[];
  raw: LocalDesktopRuntimeEvent;
};

export class LocalDesktopRuntimeClient {
  onAssistantMessage?: (message: LocalDesktopAssistantMessage) => void;
  onEvent?: (event: LocalDesktopRuntimeEvent) => void;

  private readonly host: string;
  private readonly port: number;
  private readonly authToken?: string;
  private readonly peerId: string;
  private readonly peerType: "dm" | "group" | "channel";
  private readonly senderId: string;
  private readonly senderName: string;
  private abortController?: AbortController;
  private reader?: ReadableStreamDefaultReader<Uint8Array>;
  private buffer = "";
  private readyResolver?: () => void;
  private readyPromise?: Promise<void>;

  constructor(options: LocalDesktopRuntimeClientOptions) {
    this.host = options.host;
    this.port = options.port;
    this.authToken = options.authToken;
    this.peerId = options.peerId ?? "desktop-default";
    this.peerType = options.peerType ?? "dm";
    this.senderId = options.senderId ?? "tui-user";
    this.senderName = options.senderName ?? "TUI User";
  }

  async connect(): Promise<void> {
    if (this.reader) {
      return;
    }

    this.abortController = new AbortController();
    this.readyPromise = new Promise<void>((resolve) => {
      this.readyResolver = resolve;
    });

    const url = new URL(`http://${this.host}:${this.port}/events`);
    url.searchParams.set("peerId", this.peerId);

    const response = await fetch(url, {
      headers: this.authHeaders(),
      signal: this.abortController.signal,
    });

    if (!response.ok || !response.body) {
      throw new Error(`Runtime SSE connection failed: ${response.status} ${response.statusText}`);
    }

    this.reader = response.body.getReader();
    void this.readLoop();
  }

  async disconnect(): Promise<void> {
    if (this.abortController) {
      this.abortController.abort();
    }
    this.abortController = undefined;

    if (this.reader) {
      try {
        await this.reader.cancel();
      } catch {
        // Ignore cancellation errors on shutdown.
      }
    }
    this.reader = undefined;
    this.buffer = "";
  }

  async waitForReady(timeoutMs = 2000): Promise<void> {
    if (!this.readyPromise) {
      return;
    }
    if (timeoutMs <= 0) {
      await this.readyPromise;
      return;
    }
    await Promise.race([
      this.readyPromise,
      new Promise<void>((_, reject) => {
        setTimeout(() => reject(new Error("Runtime SSE ready timeout")), timeoutMs);
      }),
    ]);
  }

  async sendText(text: string): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed) {
      return;
    }

    const url = new URL(`http://${this.host}:${this.port}/inbound`);
    const body = {
      id: `tui-${randomUUID()}`,
      text: trimmed,
      peerId: this.peerId,
      peerType: this.peerType,
      senderId: this.senderId,
      senderName: this.senderName,
      raw: {
        source: "tui-runtime",
      },
    };

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...this.authHeaders(),
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw new Error(`Runtime inbound failed: ${response.status} ${response.statusText}`);
    }
  }

  private async readLoop(): Promise<void> {
    if (!this.reader) {
      return;
    }
    const decoder = new TextDecoder();

    try {
      while (this.reader) {
        const { done, value } = await this.reader.read();
        if (done) {
          break;
        }
        if (value) {
          const chunk = decoder.decode(value);
          this.handleSseChunk(chunk.replace(/\r\n/g, "\n"));
        }
      }
    } catch (error) {
      if (this.abortController?.signal.aborted) {
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      this.onEvent?.({ type: "error", error: message });
    }
  }

  private handleSseChunk(chunk: string): void {
    this.buffer += chunk;
    let separatorIndex = this.buffer.indexOf("\n\n");
    while (separatorIndex >= 0) {
      const rawEvent = this.buffer.slice(0, separatorIndex);
      this.buffer = this.buffer.slice(separatorIndex + 2);
      this.handleEventBlock(rawEvent);
      separatorIndex = this.buffer.indexOf("\n\n");
    }
  }

  private handleEventBlock(rawEvent: string): void {
    const lines = rawEvent.split("\n");
    const dataLines: string[] = [];
    let eventName: string | undefined;

    for (const line of lines) {
      if (line.startsWith("event:")) {
        eventName = line.slice("event:".length).trim();
        continue;
      }
      if (line.startsWith("data:")) {
        const data = line.slice("data:".length);
        dataLines.push(data.startsWith(" ") ? data.slice(1) : data);
      }
    }

    if (dataLines.length === 0) {
      if (eventName === "ready") {
        this.markReady();
      }
      return;
    }

    const dataText = dataLines.join("\n").trim();
    if (!dataText) {
      return;
    }

    let payload: LocalDesktopRuntimeEvent;
    try {
      payload = JSON.parse(dataText) as LocalDesktopRuntimeEvent;
    } catch {
      return;
    }

    if (!payload.type && eventName) {
      payload = { ...payload, type: eventName } as LocalDesktopRuntimeEvent;
    }

    if (payload.type === "ready") {
      this.markReady();
    }

    this.onEvent?.(payload);

    if (payload.type === "assistant_message") {
      const messagePayload = payload.payload as { text?: string; media?: unknown[] } | undefined;
      const text = messagePayload?.text ?? "";
      this.onAssistantMessage?.({ text, media: messagePayload?.media, raw: payload });
    }
  }

  private markReady(): void {
    if (this.readyResolver) {
      this.readyResolver();
      this.readyResolver = undefined;
    }
  }

  private authHeaders(): Record<string, string> {
    if (!this.authToken) {
      return {};
    }
    return { authorization: `Bearer ${this.authToken}` };
  }
}
