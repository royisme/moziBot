import type { Phase } from "../renderers/types";

export type MoziClientConfig = {
  baseUrl: string;
  peerId: string;
  authToken?: string;
};

export type MoziClientEvents = {
  phase: (phase: Phase) => void;
  transcript: (text: string, isUser: boolean, isFinal: boolean) => void;
  assistantMessage: (text: string) => void;
  audioMeta: (streamId: string, mimeType: string, durationMs: number, text: string) => void;
  audioChunk: (streamId: string, chunkBase64: string, isLast: boolean) => void;
  sseConnected: () => void;
  sseDisconnected: () => void;
  wsConnected: () => void;
  wsDisconnected: () => void;
};

type Listener<K extends keyof MoziClientEvents> = MoziClientEvents[K];

export class MoziClient {
  private config: MoziClientConfig;
  private eventSource: EventSource | null = null;
  private ws: WebSocket | null = null;
  private listeners = new Map<string, Set<Function>>();
  private wsReconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private wsReconnectAttempt = 0;
  private destroyed = false;

  private static readonly WS_BACKOFF = [1000, 2000, 5000];

  constructor(config: MoziClientConfig) {
    this.config = config;
  }

  on<K extends keyof MoziClientEvents>(event: K, fn: Listener<K>): void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(fn);
  }

  off<K extends keyof MoziClientEvents>(event: K, fn: Listener<K>): void {
    this.listeners.get(event)?.delete(fn);
  }

  private emit<K extends keyof MoziClientEvents>(
    event: K,
    ...args: Parameters<MoziClientEvents[K]>
  ): void {
    const fns = this.listeners.get(event);
    if (!fns) return;
    for (const fn of fns) {
      try {
        (fn as Function)(...args);
      } catch {
        // listener error; swallow
      }
    }
  }

  connectSse(): void {
    if (this.eventSource) return;
    const url = new URL(`${this.config.baseUrl}/events`);
    url.searchParams.set("peerId", this.config.peerId);
    if (this.config.authToken) {
      url.searchParams.set("token", this.config.authToken);
    }

    this.eventSource = new EventSource(url.toString());

    this.eventSource.addEventListener("open", () => {
      this.emit("sseConnected");
    });

    this.eventSource.addEventListener("message", (event) => {
      try {
        const data = JSON.parse(event.data) as Record<string, unknown>;
        this.handleSseEvent(data);
      } catch {
        // ignore malformed events
      }
    });

    this.eventSource.addEventListener("error", () => {
      this.emit("sseDisconnected");
    });
  }

  connectWs(): void {
    if (this.ws) return;
    const url = new URL(`${this.config.baseUrl}/audio`);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set("peerId", this.config.peerId);
    if (this.config.authToken) {
      url.searchParams.set("token", this.config.authToken);
    }

    this.ws = new WebSocket(url.toString());

    this.ws.addEventListener("open", () => {
      this.wsReconnectAttempt = 0;
      this.emit("wsConnected");
    });

    this.ws.addEventListener("message", (event) => {
      try {
        const data = JSON.parse(event.data as string) as Record<string, unknown>;
        this.handleWsMessage(data);
      } catch {
        // ignore
      }
    });

    this.ws.addEventListener("close", () => {
      this.ws = null;
      this.emit("wsDisconnected");
      this.scheduleWsReconnect();
    });

    this.ws.addEventListener("error", () => {
      // close event will follow
    });
  }

  sendAudioChunk(streamId: string, seq: number, sampleRate: number, chunkBase64: string): void {
    this.wsSend({
      type: "audio_chunk",
      streamId,
      seq,
      sampleRate,
      channels: 1,
      encoding: "pcm_s16le",
      chunkBase64,
      timestampMs: Date.now(),
    });
  }

  sendAudioCommit(streamId: string, totalChunks: number, reason: string): void {
    this.wsSend({
      type: "audio_commit",
      streamId,
      totalChunks,
      reason,
    });
  }

  sendText(text: string): void {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.config.authToken) {
      headers.authorization = `Bearer ${this.config.authToken}`;
    }
    void fetch(`${this.config.baseUrl}/inbound`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        peerId: this.config.peerId,
        senderId: "desktop-user",
        senderName: "Desktop User",
        text,
      }),
    });
  }

  destroy(): void {
    this.destroyed = true;
    if (this.wsReconnectTimer) {
      clearTimeout(this.wsReconnectTimer);
    }
    this.eventSource?.close();
    this.eventSource = null;
    this.ws?.close(1000, "client_shutdown");
    this.ws = null;
    this.listeners.clear();
  }

  private wsSend(data: Record<string, unknown>): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
    }
  }

  private handleSseEvent(data: Record<string, unknown>): void {
    if (typeof data.phase === "string") {
      this.emit("phase", data.phase as Phase);
    }
    if (data.type === "transcript") {
      this.emit(
        "transcript",
        data.text as string,
        data.isUser as boolean,
        data.isFinal as boolean,
      );
    }
    if (data.type === "assistant_message") {
      const payload = data.payload as Record<string, unknown> | undefined;
      this.emit("assistantMessage", (payload?.text as string) ?? "");
    }
  }

  private handleWsMessage(data: Record<string, unknown>): void {
    if (data.type === "audio_meta") {
      this.emit(
        "audioMeta",
        data.streamId as string,
        data.mimeType as string,
        data.durationMs as number,
        data.text as string,
      );
    }
    if (data.type === "audio_chunk") {
      this.emit(
        "audioChunk",
        data.streamId as string,
        data.chunkBase64 as string,
        data.isLast as boolean,
      );
    }
    if (data.type === "pong") {
      // heartbeat response; no action needed
    }
  }

  private scheduleWsReconnect(): void {
    if (this.destroyed) return;
    const delay =
      MoziClient.WS_BACKOFF[
        Math.min(this.wsReconnectAttempt, MoziClient.WS_BACKOFF.length - 1)
      ];
    this.wsReconnectAttempt++;
    this.wsReconnectTimer = setTimeout(() => {
      if (!this.destroyed) {
        this.connectWs();
      }
    }, delay);
  }
}
