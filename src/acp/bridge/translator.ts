import { randomUUID } from "node:crypto";
import type {
  Agent,
  AgentSideConnection,
  AuthenticateRequest,
  AuthenticateResponse,
  CancelNotification,
  InitializeRequest,
  InitializeResponse,
  ListSessionsRequest,
  ListSessionsResponse,
  LoadSessionRequest,
  LoadSessionResponse,
  NewSessionRequest,
  NewSessionResponse,
  PromptRequest,
  PromptResponse,
  SetSessionModeRequest,
  SetSessionModeResponse,
  StopReason,
} from "@agentclientprotocol/sdk";
import { PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import { getAvailableCommands } from "./commands";
import {
  extractAttachmentsFromPrompt,
  extractTextFromPrompt,
  formatToolTitle,
  inferToolKind,
} from "./event-mapper";
import { parseSessionMeta, resetSessionIfNeeded, resolveSessionKey } from "./session-mapper";
import { defaultAcpSessionStore, type AcpSessionStore } from "./session-store";
import { ACP_AGENT_INFO, type AcpServerOptions } from "./types";
import type { AcpBridgeRuntimeAdapter } from "./runtime-adapter";

// Maximum allowed prompt size (2MB) to prevent DoS via memory exhaustion (CWE-400, GHSA-cxpw-2g23-2vgw)
const MAX_PROMPT_BYTES = 2 * 1024 * 1024;

type FixedWindowRateLimiter = {
  consume: () => {
    allowed: boolean;
    retryAfterMs: number;
    remaining: number;
  };
};

function createFixedWindowRateLimiter(params: {
  maxRequests: number;
  windowMs: number;
}): FixedWindowRateLimiter {
  const maxRequests = Math.max(1, Math.floor(params.maxRequests));
  const windowMs = Math.max(1, Math.floor(params.windowMs));

  let count = 0;
  let windowStartMs = 0;

  return {
    consume() {
      const nowMs = Date.now();
      if (nowMs - windowStartMs >= windowMs) {
        windowStartMs = nowMs;
        count = 0;
      }
      if (count >= maxRequests) {
        return {
          allowed: false,
          retryAfterMs: Math.max(0, windowStartMs + windowMs - nowMs),
          remaining: 0,
        };
      }
      count += 1;
      return {
        allowed: true,
        retryAfterMs: 0,
        remaining: Math.max(0, maxRequests - count),
      };
    },
  };
}

function shortenHomePath(p: string): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  if (home && p.startsWith(home)) {
    return `~${p.slice(home.length)}`;
  }
  return p;
}

type PendingPrompt = {
  sessionId: string;
  sessionKey: string;
  idempotencyKey: string;
  resolve: (response: PromptResponse) => void;
  reject: (err: Error) => void;
  sentTextLength?: number;
  sentText?: string;
  toolCallIds?: Set<string>;
};

type AcpGatewayAgentOptions = AcpServerOptions & {
  sessionStore?: AcpSessionStore;
};

const SESSION_CREATE_RATE_LIMIT_DEFAULT_MAX_REQUESTS = 120;
const SESSION_CREATE_RATE_LIMIT_DEFAULT_WINDOW_MS = 10_000;

export class AcpGatewayAgent implements Agent {
  private connection: AgentSideConnection;
  private adapter: AcpBridgeRuntimeAdapter;
  private opts: AcpGatewayAgentOptions;
  private log: (msg: string) => void;
  private sessionStore: AcpSessionStore;
  private sessionCreateRateLimiter: FixedWindowRateLimiter;
  private pendingPrompts = new Map<string, PendingPrompt>();

  constructor(
    connection: AgentSideConnection,
    adapter: AcpBridgeRuntimeAdapter,
    opts: AcpGatewayAgentOptions = {},
  ) {
    this.connection = connection;
    this.adapter = adapter;
    this.opts = opts;
    this.log = opts.verbose ? (msg: string) => process.stderr.write(`[acp] ${msg}\n`) : () => {};
    this.sessionStore = opts.sessionStore ?? defaultAcpSessionStore;
    this.sessionCreateRateLimiter = createFixedWindowRateLimiter({
      maxRequests: Math.max(
        1,
        opts.sessionCreateRateLimit?.maxRequests ?? SESSION_CREATE_RATE_LIMIT_DEFAULT_MAX_REQUESTS,
      ),
      windowMs: Math.max(
        1_000,
        opts.sessionCreateRateLimit?.windowMs ?? SESSION_CREATE_RATE_LIMIT_DEFAULT_WINDOW_MS,
      ),
    });
  }

  start(): void {
    this.log("ready");
  }

  async initialize(_params: InitializeRequest): Promise<InitializeResponse> {
    return {
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: {
          image: true,
          audio: false,
          embeddedContext: true,
        },
        mcpCapabilities: {
          http: false,
          sse: false,
        },
        sessionCapabilities: {
          list: {},
        },
      },
      agentInfo: ACP_AGENT_INFO,
      authMethods: [],
    };
  }

  async newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
    if (params.mcpServers.length > 0) {
      this.log(`ignoring ${params.mcpServers.length} MCP servers`);
    }
    this.enforceSessionCreateRateLimit("newSession");

    const sessionId = randomUUID();
    const meta = parseSessionMeta(params._meta);
    const sessionKey = await resolveSessionKey({
      meta,
      fallbackKey: `acp:${sessionId}`,
      opts: this.opts,
      adapter: this.adapter,
    });
    await resetSessionIfNeeded({
      meta,
      sessionKey,
      opts: this.opts,
      onReset: (key) => this.adapter.resetSession(key),
    });

    const session = this.sessionStore.createSession({
      sessionId,
      sessionKey,
      cwd: params.cwd,
    });
    this.log(`newSession: ${session.sessionId} -> ${session.sessionKey}`);
    await this.sendAvailableCommands(session.sessionId);
    return { sessionId: session.sessionId };
  }

  async loadSession(params: LoadSessionRequest): Promise<LoadSessionResponse> {
    if (params.mcpServers.length > 0) {
      this.log(`ignoring ${params.mcpServers.length} MCP servers`);
    }
    if (!this.sessionStore.hasSession(params.sessionId)) {
      this.enforceSessionCreateRateLimit("loadSession");
    }

    const meta = parseSessionMeta(params._meta);
    const sessionKey = await resolveSessionKey({
      meta,
      fallbackKey: params.sessionId,
      opts: this.opts,
      adapter: this.adapter,
    });
    await resetSessionIfNeeded({
      meta,
      sessionKey,
      opts: this.opts,
      onReset: (key) => this.adapter.resetSession(key),
    });

    const session = this.sessionStore.createSession({
      sessionId: params.sessionId,
      sessionKey,
      cwd: params.cwd,
    });
    this.log(`loadSession: ${session.sessionId} -> ${session.sessionKey}`);
    await this.sendAvailableCommands(session.sessionId);
    return {};
  }

  async unstable_listSessions(params: ListSessionsRequest): Promise<ListSessionsResponse> {
    const sessions = await this.adapter.listSessions();
    const cwd = params.cwd ?? process.cwd();
    return {
      sessions: sessions.map((session) => ({
        sessionId: session.key,
        cwd,
        title: session.label ?? session.key,
        updatedAt: undefined,
        _meta: {
          sessionKey: session.key,
        },
      })),
      nextCursor: null,
    };
  }

  async authenticate(_params: AuthenticateRequest): Promise<AuthenticateResponse> {
    return {};
  }

  async setSessionMode(params: SetSessionModeRequest): Promise<SetSessionModeResponse> {
    const session = this.sessionStore.getSession(params.sessionId);
    if (!session) {
      throw new Error(`Session ${params.sessionId} not found`);
    }
    this.log(`setSessionMode: ${session.sessionId} -> ${params.modeId ?? "(none)"}`);
    return {};
  }

  async prompt(params: PromptRequest): Promise<PromptResponse> {
    const session = this.sessionStore.getSession(params.sessionId);
    if (!session) {
      throw new Error(`Session ${params.sessionId} not found`);
    }

    if (session.abortController) {
      this.sessionStore.cancelActiveRun(params.sessionId);
    }

    const meta = parseSessionMeta(params._meta);
    // Pass MAX_PROMPT_BYTES so extractTextFromPrompt rejects oversized content
    // block-by-block, before the full string is ever assembled in memory (CWE-400)
    const userText = extractTextFromPrompt(params.prompt, MAX_PROMPT_BYTES);
    const attachments = extractAttachmentsFromPrompt(params.prompt);
    const prefixCwd = meta.prefixCwd ?? this.opts.prefixCwd ?? true;
    const displayCwd = shortenHomePath(session.cwd);
    const message = prefixCwd ? `[Working directory: ${displayCwd}]\n\n${userText}` : userText;

    // Defense-in-depth: also check the final assembled message (includes cwd prefix)
    if (Buffer.byteLength(message, "utf-8") > MAX_PROMPT_BYTES) {
      throw new Error(`Prompt exceeds maximum allowed size of ${MAX_PROMPT_BYTES} bytes`);
    }

    const abortController = new AbortController();
    const runId = randomUUID();
    this.sessionStore.setActiveRun(params.sessionId, runId, abortController);

    return new Promise<PromptResponse>((resolve, reject) => {
      const pending: PendingPrompt = {
        sessionId: params.sessionId,
        sessionKey: session.sessionKey,
        idempotencyKey: runId,
        resolve,
        reject,
      };
      this.pendingPrompts.set(params.sessionId, pending);

      void this.runAdapterStream({
        pending,
        sessionKey: session.sessionKey,
        message,
        attachments,
        signal: abortController.signal,
      });
    });
  }

  private async runAdapterStream(params: {
    pending: PendingPrompt;
    sessionKey: string;
    message: string;
    attachments: Array<{ type: string; mimeType: string; content: string }>;
    signal: AbortSignal;
  }): Promise<void> {
    const { pending, sessionKey, message, attachments, signal } = params;
    const { sessionId } = pending;

    try {
      const eventStream = this.adapter.sendMessage({
        sessionKey,
        text: message,
        attachments: attachments.length > 0 ? attachments : undefined,
        signal,
      });

      for await (const evt of eventStream) {
        // If cancelled mid-stream, stop processing
        if (!this.pendingPrompts.has(sessionId)) {
          break;
        }

        if (evt.type === "text_delta") {
          await this.handleTextDelta(sessionId, evt.text);
        } else if (evt.type === "tool_use") {
          await this.handleToolUse(sessionId, pending, evt);
        } else if (evt.type === "tool_result") {
          await this.handleToolResult(sessionId, pending, evt);
        } else if (evt.type === "done") {
          const stopReason = this.mapStopReason(evt.stopReason);
          this.finishPrompt(sessionId, pending, stopReason);
          return;
        } else if (evt.type === "error") {
          const currentPending = this.pendingPrompts.get(sessionId);
          if (currentPending) {
            this.pendingPrompts.delete(sessionId);
            this.sessionStore.clearActiveRun(sessionId);
            currentPending.reject(new Error(evt.message));
          }
          return;
        }
      }

      // Stream ended without explicit done event
      if (this.pendingPrompts.has(sessionId)) {
        this.finishPrompt(sessionId, pending, "end_turn");
      }
    } catch (err) {
      const currentPending = this.pendingPrompts.get(sessionId);
      if (currentPending) {
        this.pendingPrompts.delete(sessionId);
        this.sessionStore.clearActiveRun(sessionId);
        currentPending.reject(err instanceof Error ? err : new Error(String(err)));
      }
    }
  }

  private mapStopReason(reason?: string): StopReason {
    switch (reason) {
      case "end_turn":
        return "end_turn";
      case "max_tokens":
        return "max_tokens";
      case "cancelled":
      case "aborted":
        return "cancelled";
      case "refusal":
        return "refusal";
      default:
        return "end_turn";
    }
  }

  private async handleTextDelta(sessionId: string, newText: string): Promise<void> {
    if (!newText) {
      return;
    }
    await this.connection.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: newText },
      },
    });
  }

  private async handleToolUse(
    sessionId: string,
    pending: PendingPrompt,
    evt: { type: "tool_use"; name: string; args?: Record<string, unknown> },
  ): Promise<void> {
    const toolCallId = randomUUID();
    if (!pending.toolCallIds) {
      pending.toolCallIds = new Set();
    }
    pending.toolCallIds.add(toolCallId);
    await this.connection.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: "tool_call",
        toolCallId,
        title: formatToolTitle(evt.name, evt.args),
        status: "in_progress",
        rawInput: evt.args,
        kind: inferToolKind(evt.name),
      },
    });
  }

  private async handleToolResult(
    sessionId: string,
    pending: PendingPrompt,
    evt: { type: "tool_result"; name: string; output?: string },
  ): Promise<void> {
    // Find the most recent tool call id for this tool
    const toolCallIds = pending.toolCallIds;
    if (!toolCallIds || toolCallIds.size === 0) {
      return;
    }
    // Use the last added tool call id
    const toolCallId = [...toolCallIds].at(-1);
    if (!toolCallId) {
      return;
    }
    await this.connection.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId,
        status: "completed",
        rawOutput: evt.output,
      },
    });
  }

  async cancel(params: CancelNotification): Promise<void> {
    const session = this.sessionStore.getSession(params.sessionId);
    if (!session) {
      return;
    }

    this.sessionStore.cancelActiveRun(params.sessionId);
    try {
      await this.adapter.abortSession(session.sessionKey);
    } catch (err) {
      this.log(`cancel error: ${String(err)}`);
    }

    const pending = this.pendingPrompts.get(params.sessionId);
    if (pending) {
      this.pendingPrompts.delete(params.sessionId);
      pending.resolve({ stopReason: "cancelled" });
    }
  }

  private finishPrompt(sessionId: string, pending: PendingPrompt, stopReason: StopReason): void {
    this.pendingPrompts.delete(sessionId);
    this.sessionStore.clearActiveRun(sessionId);
    pending.resolve({ stopReason });
  }

  private async sendAvailableCommands(sessionId: string): Promise<void> {
    await this.connection.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: "available_commands_update",
        availableCommands: getAvailableCommands(),
      },
    });
  }

  private enforceSessionCreateRateLimit(method: "newSession" | "loadSession"): void {
    const budget = this.sessionCreateRateLimiter.consume();
    if (budget.allowed) {
      return;
    }
    throw new Error(
      `ACP session creation rate limit exceeded for ${method}; retry after ${Math.ceil(budget.retryAfterMs / 1_000)}s.`,
    );
  }
}
