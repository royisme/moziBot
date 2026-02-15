import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { WebSocketServer, type RawData, type WebSocket } from "ws";
import type { MoziConfig } from "../../../../config";
import type { InboundMessage, MediaAttachment, OutboundMessage } from "../types";
import { logger } from "../../../../logger";
import { SttService } from "../../../media-understanding/stt-service";
import { TtsService } from "../../../tts/tts-service";
import { BaseChannelPlugin } from "../plugin";

export interface LocalDesktopPluginConfig {
  enabled?: boolean;
  host?: string;
  port?: number;
  authToken?: string;
  allowOrigins?: string[];
  voice?: MoziConfig["voice"];
}

type LocalWidgetConfigPayload = {
  enabled: boolean;
  host: string;
  port: number;
  peerId: string;
  authToken?: string;
};

type EventPhase = "idle" | "listening" | "thinking" | "speaking" | "executing" | "error";

type SseClient = {
  id: string;
  peerId: string;
  res: ServerResponse;
};

type AudioWsClient = {
  id: string;
  peerId: string;
  socket: WebSocket;
};

type AudioInboundStream = {
  streamId: string;
  chunks: Buffer[];
  sampleRate: number;
  channels: number;
  encoding: "pcm_s16le";
};

export class LocalDesktopPlugin extends BaseChannelPlugin {
  readonly id = "localDesktop";
  readonly name = "Local Desktop";

  private server: ReturnType<typeof createServer> | null = null;
  private audioWsServer: WebSocketServer | null = null;
  private clients = new Map<string, SseClient>();
  private audioClients = new Map<string, AudioWsClient>();
  private audioStreams = new Map<string, AudioInboundStream>();
  private sttService: SttService;
  private ttsService: TtsService;

  constructor(private config: LocalDesktopPluginConfig) {
    super();
    this.sttService = new SttService({ voice: config.voice } as MoziConfig);
    this.ttsService = new TtsService({ voice: config.voice } as MoziConfig);
  }

  async connect(): Promise<void> {
    if (this.server) {
      return;
    }
    this.setStatus("connecting");
    const host = this.config.host ?? "127.0.0.1";
    const port = this.config.port ?? 3987;

    this.server = createServer(async (req, res) => {
      try {
        await this.handleRequest(req, res);
      } catch (error) {
        logger.warn({ err: error }, "Local desktop request failed");
        this.writeJson(res, 500, { error: "internal_error" });
      }
    });

    this.audioWsServer = new WebSocketServer({ noServer: true });
    this.server.on("upgrade", (req, socket, head) => {
      void this.handleUpgrade(req, socket, head);
    });

    await new Promise<void>((resolve, reject) => {
      const s = this.server;
      if (!s) {
        reject(new Error("Local desktop server missing"));
        return;
      }
      s.once("error", reject);
      s.listen(port, host, () => {
        s.off("error", reject);
        resolve();
      });
    });

    this.setStatus("connected");
    logger.info({ host, port: this.getPort() }, "Local desktop channel connected");
  }

  async disconnect(): Promise<void> {
    const server = this.server;
    this.server = null;
    this.audioWsServer?.close();
    this.audioWsServer = null;
    for (const client of this.clients.values()) {
      client.res.end();
    }
    this.clients.clear();
    for (const client of this.audioClients.values()) {
      client.socket.close(1001, "server_shutdown");
    }
    this.audioClients.clear();
    this.audioStreams.clear();

    if (!server) {
      this.setStatus("disconnected");
      return;
    }

    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    this.setStatus("disconnected");
  }

  private async handleUpgrade(
    req: IncomingMessage,
    socket: Parameters<WebSocketServer["handleUpgrade"]>[1],
    head: Parameters<WebSocketServer["handleUpgrade"]>[2],
  ): Promise<void> {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.pathname !== "/audio") {
        socket.destroy();
        return;
      }

      if (!this.isAuthorized(req, url)) {
        socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return;
      }

      const peerId = url.searchParams.get("peerId") ?? "desktop-default";
      const wsServer = this.audioWsServer;
      if (!wsServer) {
        socket.write("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return;
      }

      wsServer.handleUpgrade(req, socket, head, (ws) => {
        this.attachAudioClient(peerId, ws);
      });
    } catch {
      socket.destroy();
    }
  }

  private attachAudioClient(peerId: string, socket: WebSocket): void {
    const existing = this.audioClients.get(peerId);
    if (existing) {
      existing.socket.close(1000, "replaced");
    }

    const client: AudioWsClient = {
      id: randomUUID(),
      peerId,
      socket,
    };

    this.audioClients.set(peerId, client);

    socket.send(
      JSON.stringify({
        type: "audio_ready",
        peerId,
        ts: Date.now(),
      }),
    );

    socket.on("message", (raw) => {
      this.handleAudioMessage(client, raw);
    });

    socket.on("close", () => {
      const latest = this.audioClients.get(peerId);
      if (latest?.id === client.id) {
        this.audioClients.delete(peerId);
      }
    });
  }

  private handleAudioMessage(client: AudioWsClient, raw: RawData): void {
    try {
      const content = this.decodeWsPayload(raw);
      const data = JSON.parse(content) as
        | {
            type?: "ping";
            ts?: number;
          }
        | {
            type?: "audio_chunk";
            streamId?: string;
            seq?: number;
            sampleRate?: number;
            channels?: number;
            encoding?: "pcm_s16le";
            chunkBase64?: string;
          }
        | {
            type?: "audio_commit";
            streamId?: string;
          };

      if (data.type === "ping") {
        client.socket.send(JSON.stringify({ type: "pong", ts: data.ts ?? Date.now() }));
        return;
      }

      if (data.type === "audio_chunk") {
        this.handleAudioChunk(client, data);
        return;
      }

      if (data.type === "audio_commit") {
        void this.handleAudioCommit(client, data);
        return;
      }

      client.socket.send(
        JSON.stringify({
          type: "error",
          code: "unsupported_message",
          message: "Unsupported audio websocket message type",
          retryable: false,
        }),
      );
    } catch {
      client.socket.send(
        JSON.stringify({
          type: "error",
          code: "invalid_payload",
          message: "Invalid websocket payload",
          retryable: false,
        }),
      );
    }
  }

  private handleAudioChunk(
    client: AudioWsClient,
    data: {
      streamId?: string;
      seq?: number;
      sampleRate?: number;
      channels?: number;
      encoding?: "pcm_s16le";
      chunkBase64?: string;
    },
  ): void {
    const streamId = typeof data.streamId === "string" ? data.streamId : "";
    const encoding = data.encoding;
    const chunkBase64 = typeof data.chunkBase64 === "string" ? data.chunkBase64 : "";
    const sampleRate = typeof data.sampleRate === "number" ? data.sampleRate : 16000;
    const channels = typeof data.channels === "number" ? data.channels : 1;

    if (!streamId || encoding !== "pcm_s16le" || !chunkBase64) {
      this.sendAudioError(client, "invalid_payload", "Invalid audio_chunk payload", false);
      return;
    }

    const key = this.makeAudioStreamKey(client.peerId, streamId);
    const existing = this.audioStreams.get(key);
    const stream: AudioInboundStream =
      existing ??
      {
        streamId,
        chunks: [],
        sampleRate,
        channels,
        encoding,
      };

    try {
      const chunk = Buffer.from(chunkBase64, "base64");
      if (chunk.byteLength === 0) {
        this.sendAudioError(client, "invalid_payload", "Empty audio chunk", false);
        return;
      }
      stream.chunks.push(chunk);
      this.audioStreams.set(key, stream);
    } catch {
      this.sendAudioError(client, "invalid_payload", "Invalid base64 audio chunk", false);
    }
  }

  private async handleAudioCommit(
    client: AudioWsClient,
    data: {
      streamId?: string;
    },
  ): Promise<void> {
    const streamId = typeof data.streamId === "string" ? data.streamId : "";
    if (!streamId) {
      this.sendAudioError(client, "invalid_payload", "Missing streamId in audio_commit", false);
      return;
    }

    const key = this.makeAudioStreamKey(client.peerId, streamId);
    const stream = this.audioStreams.get(key);
    this.audioStreams.delete(key);

    if (!stream || stream.chunks.length === 0) {
      this.sendAudioError(client, "invalid_payload", "No buffered audio for streamId", false);
      return;
    }

    const pcmBuffer = Buffer.concat(stream.chunks);
    const wavBuffer = this.buildWavFromPcm16(pcmBuffer, stream.sampleRate, stream.channels);

    await this.emitPhase(client.peerId, "listening");

    const inbound: InboundMessage = {
      id: `local-audio-${randomUUID()}`,
      channel: this.id,
      peerId: client.peerId,
      peerType: "dm",
      senderId: "desktop-user",
      senderName: "Desktop User",
      text: "",
      media: [
        {
          type: "voice",
          buffer: wavBuffer,
          mimeType: "audio/wav",
          filename: `${stream.streamId}.wav`,
        },
      ],
      timestamp: new Date(),
      raw: {
        source: "audio_ws",
        streamId: stream.streamId,
      },
    };

    const transcript = await this.sttService.transcribeInboundMessage(inbound);
    if (!transcript || !transcript.trim()) {
      this.sendAudioError(client, "stt_failed", "STT failed to produce transcript", true);
      await this.emitPhase(client.peerId, "error");
      return;
    }

    this.broadcast(client.peerId, {
      type: "transcript",
      peerId: client.peerId,
      text: transcript,
      isUser: true,
      isFinal: true,
      streamId: stream.streamId,
      timestamp: new Date().toISOString(),
    });

    this.emitMessage({
      ...inbound,
      text: transcript,
      media: undefined,
    });
  }

  private sendAudioError(
    client: AudioWsClient,
    code:
      | "unauthorized"
      | "invalid_payload"
      | "unsupported_message"
      | "unsupported_audio_format"
      | "stt_failed"
      | "tts_failed"
      | "internal_error",
    message: string,
    retryable: boolean,
  ): void {
    client.socket.send(
      JSON.stringify({
        type: "error",
        code,
        message,
        retryable,
      }),
    );
  }

  private makeAudioStreamKey(peerId: string, streamId: string): string {
    return `${peerId}:${streamId}`;
  }

  private buildWavFromPcm16(pcm: Buffer, sampleRate: number, channels: number): Buffer {
    const bitsPerSample = 16;
    const byteRate = sampleRate * channels * (bitsPerSample / 8);
    const blockAlign = channels * (bitsPerSample / 8);
    const dataSize = pcm.byteLength;
    const header = Buffer.alloc(44);

    header.write("RIFF", 0, "ascii");
    header.writeUInt32LE(36 + dataSize, 4);
    header.write("WAVE", 8, "ascii");
    header.write("fmt ", 12, "ascii");
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(channels, 22);
    header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(byteRate, 28);
    header.writeUInt16LE(blockAlign, 32);
    header.writeUInt16LE(bitsPerSample, 34);
    header.write("data", 36, "ascii");
    header.writeUInt32LE(dataSize, 40);

    return Buffer.concat([header, pcm]);
  }

  private decodeWsPayload(raw: RawData): string {
    if (typeof raw === "string") {
      return raw;
    }
    if (Buffer.isBuffer(raw)) {
      return raw.toString("utf8");
    }
    if (raw instanceof ArrayBuffer) {
      return Buffer.from(raw).toString("utf8");
    }
    if (Array.isArray(raw)) {
      return Buffer.concat(raw).toString("utf8");
    }
    return Buffer.from(raw).toString("utf8");
  }

  async send(peerId: string, message: OutboundMessage): Promise<string> {
    const eventId = `out-${randomUUID()}`;
    const text = message.text ?? "";
    this.broadcast(peerId, {
      type: "assistant_message",
      id: eventId,
      peerId,
      payload: {
        text,
        media: message.media ?? [],
      },
      timestamp: new Date().toISOString(),
    });

    if (text.trim()) {
      await this.sendTtsAudio(peerId, text);
    }

    return eventId;
  }

  private async sendTtsAudio(peerId: string, text: string): Promise<void> {
    const audioClient = this.audioClients.get(peerId);
    if (!audioClient) {
      return;
    }

    try {
      const result = await this.ttsService.textToSpeech(text, { peerId });
      const streamId = `tts-${randomUUID()}`;
      const chunkSize = 32 * 1024;
      let seq = 0;

      audioClient.socket.send(
        JSON.stringify({
          type: "audio_meta",
          streamId,
          mimeType: result.mimeType,
          durationMs: result.durationMs ?? 0,
          text,
          voice: result.voice,
        }),
      );

      for (let offset = 0; offset < result.buffer.byteLength; offset += chunkSize) {
        const end = Math.min(offset + chunkSize, result.buffer.byteLength);
        const chunk = result.buffer.subarray(offset, end);
        audioClient.socket.send(
          JSON.stringify({
            type: "audio_chunk",
            streamId,
            seq,
            mimeType: result.mimeType,
            chunkBase64: chunk.toString("base64"),
            isLast: end >= result.buffer.byteLength,
          }),
        );
        seq += 1;
      }

      this.broadcast(peerId, {
        type: "audio_ready",
        peerId,
        streamId,
        mimeType: result.mimeType,
        durationMs: result.durationMs ?? 0,
        timestamp: new Date().toISOString(),
      });
    } catch {
      this.sendAudioError(audioClient, "tts_failed", "TTS failed to generate audio", true);
    }
  }

  async emitPhase(
    peerId: string,
    phase: EventPhase,
    payload?: {
      sessionKey?: string;
      agentId?: string;
      toolName?: string;
      toolCallId?: string;
      messageId?: string;
    },
  ): Promise<void> {
    this.broadcast(peerId, {
      type: "phase",
      peerId,
      phase,
      payload: payload ?? {},
      timestamp: new Date().toISOString(),
    });
  }

  getPort(): number | null {
    const address = this.server?.address();
    if (!address || typeof address === "string") {
      return null;
    }
    return address.port;
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method ?? "GET";
    const url = new URL(req.url ?? "/", "http://localhost");

    if (method === "GET" && url.pathname === "/widget-config") {
      this.writeJson(res, 200, this.getWidgetConfigPayload());
      return;
    }

    if (!this.isAuthorized(req, url)) {
      this.writeJson(res, 401, { error: "unauthorized" });
      return;
    }

    if (method === "OPTIONS") {
      this.writeCorsHeaders(req, res);
      res.statusCode = 204;
      res.end();
      return;
    }

    if (method === "POST" && url.pathname === "/inbound") {
      const body = await this.readJsonBody(req);
      const msg = this.buildInboundMessage(body);
      if (!msg) {
        this.writeJson(res, 400, { error: "invalid_inbound_payload" });
        return;
      }
      this.emitMessage(msg);
      this.writeJson(res, 202, { accepted: true, id: msg.id });
      return;
    }

    if (method === "GET" && url.pathname === "/events") {
      const peerId = url.searchParams.get("peerId") ?? "desktop-default";
      this.openSse(peerId, req, res);
      return;
    }

    if (method === "GET" && url.pathname === "/health") {
      this.writeJson(res, 200, { ok: true, channel: this.id });
      return;
    }

    this.writeJson(res, 404, { error: "not_found" });
  }

  private isAuthorized(req: IncomingMessage, url: URL): boolean {
    const expected = this.config.authToken?.trim();
    if (!expected) {
      return true;
    }
    const auth = req.headers.authorization;
    const bearer =
      typeof auth === "string" && auth.startsWith("Bearer ") ? auth.slice(7) : undefined;
    const headerToken = req.headers["x-mozi-token"];
    const explicit = typeof headerToken === "string" ? headerToken : undefined;
    const queryToken = url.searchParams.get("token") ?? undefined;
    return bearer === expected || explicit === expected || queryToken === expected;
  }

  private openSse(peerId: string, req: IncomingMessage, res: ServerResponse): void {
    this.writeCorsHeaders(req, res);
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    });

    const clientId = randomUUID();
    this.clients.set(clientId, { id: clientId, peerId, res });
    res.write(`event: ready\ndata: ${JSON.stringify({ peerId, ts: Date.now() })}\n\n`);

    req.on("close", () => {
      this.clients.delete(clientId);
      res.end();
    });
  }

  private broadcast(peerId: string, payload: Record<string, unknown>): void {
    const data = `data: ${JSON.stringify(payload)}\n\n`;
    for (const client of this.clients.values()) {
      if (client.peerId === peerId) {
        client.res.write(data);
      }
    }
  }

  private async readJsonBody(req: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const raw = Buffer.concat(chunks).toString("utf8").trim();
    if (!raw) {
      return {};
    }
    return JSON.parse(raw);
  }

  private buildInboundMessage(body: unknown): InboundMessage | null {
    if (!body || typeof body !== "object") {
      return null;
    }
    const data = body as Record<string, unknown>;
    const text = typeof data.text === "string" ? data.text : "";
    const peerId =
      typeof data.peerId === "string" && data.peerId.trim() ? data.peerId : "desktop-default";
    const senderId =
      typeof data.senderId === "string" && data.senderId.trim() ? data.senderId : "desktop-user";
    const senderName =
      typeof data.senderName === "string" && data.senderName.trim()
        ? data.senderName
        : "Desktop User";
    const peerType =
      data.peerType === "group" || data.peerType === "channel" ? data.peerType : "dm";
    const media: MediaAttachment[] | undefined = Array.isArray(data.media)
      ? data.media
          .filter((item) => !!item && typeof item === "object")
          .map((item) => item as MediaAttachment)
      : undefined;

    return {
      id: typeof data.id === "string" && data.id.trim() ? data.id : `local-${randomUUID()}`,
      channel: this.id,
      peerId,
      peerType,
      senderId,
      senderName,
      text,
      media,
      timestamp: new Date(),
      raw: body,
    };
  }

  private writeJson(res: ServerResponse, statusCode: number, body: Record<string, unknown>): void {
    this.writeCorsHeaders(undefined, res);
    res.statusCode = statusCode;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.end(JSON.stringify(body));
  }

  private writeCorsHeaders(req: IncomingMessage | undefined, res: ServerResponse): void {
    const origin = req?.headers.origin;
    const allowOrigins = this.config.allowOrigins;
    if (!origin) {
      return;
    }
    if (!allowOrigins || allowOrigins.length === 0 || allowOrigins.includes(origin)) {
      res.setHeader("access-control-allow-origin", origin);
      res.setHeader("vary", "Origin");
      res.setHeader("access-control-allow-headers", "Content-Type, Authorization, X-Mozi-Token");
      res.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
    }
  }

  private getWidgetConfigPayload(): LocalWidgetConfigPayload {
    return {
      enabled: this.config.enabled !== false,
      host: "127.0.0.1",
      port: this.getPort() ?? this.config.port ?? 3987,
      peerId: "desktop-default",
      authToken: this.config.authToken,
    };
  }
}
