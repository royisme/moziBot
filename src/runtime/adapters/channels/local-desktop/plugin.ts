import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { InboundMessage, MediaAttachment, OutboundMessage } from "../types";
import { logger } from "../../../../logger";
import { BaseChannelPlugin } from "../plugin";

export interface LocalDesktopPluginConfig {
  enabled?: boolean;
  host?: string;
  port?: number;
  authToken?: string;
  allowOrigins?: string[];
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

export class LocalDesktopPlugin extends BaseChannelPlugin {
  readonly id = "localDesktop";
  readonly name = "Local Desktop";

  private server: ReturnType<typeof createServer> | null = null;
  private clients = new Map<string, SseClient>();

  constructor(private config: LocalDesktopPluginConfig) {
    super();
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
    for (const client of this.clients.values()) {
      client.res.end();
    }
    this.clients.clear();

    if (!server) {
      this.setStatus("disconnected");
      return;
    }

    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    this.setStatus("disconnected");
  }

  async send(peerId: string, message: OutboundMessage): Promise<string> {
    const eventId = `out-${randomUUID()}`;
    this.broadcast(peerId, {
      type: "assistant_message",
      id: eventId,
      peerId,
      payload: {
        text: message.text ?? "",
        media: message.media ?? [],
      },
      timestamp: new Date().toISOString(),
    });
    return eventId;
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
