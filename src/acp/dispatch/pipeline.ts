import type { MoziConfig } from "../../config/schema";
import type { InboundMessage } from "../../runtime/adapters/channels/types";
import type { AcpBridgeEvent, AcpBridgeRuntimeAdapter } from "../bridge/runtime-adapter";
import { resolveAcpDispatchPolicyError } from "../policy";
import {
  listAcpSessionEntries,
  readAcpSessionEntry,
  upsertAcpSessionMeta,
} from "../runtime/session-meta";
import { isAcpSessionKey, resolveSessionKey } from "../session-key-utils";
import type { SessionAcpMeta } from "../types";
import {
  createAcpReplyProjector,
  type AcpProjectedReply,
  type AcpReplyProjectorConfig,
} from "./reply-projector";

/**
 * Dispatch result containing the session key and metadata for the dispatched message.
 */
export interface AcpDispatchResult {
  sessionKey: string;
  meta: SessionAcpMeta;
  messageId: string;
}

/**
 * Parameters for dispatching a message to an ACP session.
 */
export interface AcpDispatchParams {
  message: InboundMessage;
  config: MoziConfig;
  adapter: AcpBridgeRuntimeAdapter;
  /**
   * Optional explicit session key override. If not provided, will be resolved from message.
   */
  sessionKey?: string;
}

export type AcpMessageBinding = {
  messageId: string;
  sessionKey: string;
  channelId: string;
  peerId: string;
  threadId?: string | number;
  boundAt: number; // timestamp when this binding was created
};

const MAX_BINDINGS = 2_000;
const DEFAULT_BINDING_TTL_MS = 24 * 60 * 60 * 1000; // 24h

function resolveConversationKey(params: {
  channelId: string;
  peerId: string;
  threadId?: string | number;
}): string {
  const channel = (params.channelId ?? "").trim().toLowerCase();
  const peer = (params.peerId ?? "").trim();
  const thread = params.threadId != null ? String(params.threadId).trim() : "";
  return `${channel}:${peer}:${thread}`;
}

function trimOrUndefined(value: string | undefined | null): string | undefined {
  const normalized = (value ?? "").trim();
  return normalized || undefined;
}

function looksLikeSessionKey(value: string): boolean {
  const text = value.trim();
  if (!text) {
    return false;
  }
  return isAcpSessionKey(text) || text.includes(":");
}

function resolveLabelHintFromText(text: string): string | null {
  const normalized = text.trim();
  if (!normalized || normalized.startsWith("/")) {
    return null;
  }

  const sessionPrefix = /^session\s*:\s*(\S+)$/i.exec(normalized);
  if (sessionPrefix?.[1]) {
    return sessionPrefix[1].trim();
  }

  const atPrefix = /^@(\S+)$/.exec(normalized);
  if (atPrefix?.[1]) {
    return atPrefix[1].trim();
  }

  // Conservatively treat single-token plain text as a potential label.
  if (/^\S+$/.test(normalized)) {
    return normalized;
  }

  return null;
}

/**
 * ACP Dispatch Pipeline
 *
 * Routes incoming messages from messaging platforms to ACP sessions.
 * Handles session resolution, message transformation, and dispatch to the runtime adapter.
 */
export class AcpDispatchPipeline {
  private readonly config: MoziConfig;
  private readonly adapter: AcpBridgeRuntimeAdapter;
  private readonly messageToSession = new Map<string, AcpMessageBinding>();
  private readonly conversationToSession = new Map<string, string>();
  private readonly conversationBoundAt = new Map<string, number>();

  constructor(params: { config: MoziConfig; adapter: AcpBridgeRuntimeAdapter }) {
    this.config = params.config;
    this.adapter = params.adapter;
    this.hydrateConversationBindings();
  }

  private hydrateConversationBindings(): void {
    // Use a timestamp slightly before startup so hydrated bindings age correctly
    // and can be TTL-evicted if they are stale (from before the restart).
    const hydratedAt = Date.now() - DEFAULT_BINDING_TTL_MS / 2;
    for (const entry of listAcpSessionEntries()) {
      for (const key of entry.acp?.conversationKeys ?? []) {
        this.conversationToSession.set(key, entry.sessionKey);
        this.conversationBoundAt.set(key, hydratedAt);
      }
    }
  }

  /**
   * Register/bind a message id to an ACP session for later replyTo-based resolution.
   */
  bindMessageToSession(params: Omit<AcpMessageBinding, "boundAt">): void {
    const messageId = params.messageId.trim();
    const sessionKey = params.sessionKey.trim();
    if (!messageId || !sessionKey) {
      return;
    }

    const boundAt = Date.now();

    this.messageToSession.set(messageId, {
      messageId,
      sessionKey,
      channelId: params.channelId.trim().toLowerCase(),
      peerId: params.peerId.trim(),
      threadId: params.threadId,
      boundAt,
    });

    const conversationKey = resolveConversationKey({
      channelId: params.channelId,
      peerId: params.peerId,
      threadId: params.threadId,
    });
    if (conversationKey !== "::") {
      this.conversationToSession.set(conversationKey, sessionKey);
      this.conversationBoundAt.set(conversationKey, boundAt);
      upsertAcpSessionMeta({
        sessionKey,
        mutate: (current) => {
          if (!current) {
            return null;
          }
          const existing = current.conversationKeys ?? [];
          if (existing.includes(conversationKey)) {
            return current;
          }
          return { ...current, conversationKeys: [...existing, conversationKey] };
        },
      });
    }

    this.pruneBindings();
  }

  /**
   * Resolve ACP session key for a given inbound message.
   *
   * Resolution order:
   * 1. Explicit session key override
   * 2. replyToId binding lookup
   * 3. Text as explicit key / key-like string
   * 4. Text label lookup (adapter/store)
   * 5. Conversation-level fallback (channel+peer+thread)
   * 6. Config defaultAgent as label lookup
   * 7. First available ACP session as fallback
   */
  async resolveSessionKeyForMessage(params: {
    message: InboundMessage;
    sessionKey?: string;
  }): Promise<string | null> {
    const explicitKey = trimOrUndefined(params.sessionKey);
    if (explicitKey) {
      const resolvedByKey = await this.adapter.resolveSessionKey({ key: explicitKey });
      if (resolvedByKey) {
        return resolvedByKey;
      }
      return explicitKey;
    }

    const replyToId = trimOrUndefined(params.message.replyToId);
    if (replyToId) {
      const binding = this.messageToSession.get(replyToId);
      if (binding?.sessionKey) {
        return binding.sessionKey;
      }
    }

    const text = (params.message.text ?? "").trim();
    if (text && looksLikeSessionKey(text)) {
      const resolvedByKey = await this.adapter.resolveSessionKey({ key: text });
      if (resolvedByKey) {
        return resolvedByKey;
      }
      return text;
    }

    const labelHint = resolveLabelHintFromText(text);
    if (labelHint) {
      const resolvedByLabel = await this.adapter.resolveSessionKey({ label: labelHint });
      if (resolvedByLabel) {
        return resolvedByLabel;
      }

      const resolvedFromStore = await resolveSessionKey({
        keyOrLabel: labelHint,
        config: this.config,
      });
      if (resolvedFromStore) {
        return resolvedFromStore;
      }
    }

    const conversationKey = resolveConversationKey({
      channelId: params.message.channel,
      peerId: params.message.peerId,
      threadId: params.message.threadId,
    });
    const conversationSession = this.conversationToSession.get(conversationKey);
    if (conversationSession) {
      return conversationSession;
    }

    const defaultAgent = trimOrUndefined(this.config.acp?.defaultAgent);
    if (defaultAgent) {
      const defaultAgentSession = await this.adapter.resolveSessionKey({ label: defaultAgent });
      if (defaultAgentSession) {
        return defaultAgentSession;
      }
    }

    const sessions = await this.adapter.listSessions();
    return sessions[0]?.key ?? null;
  }

  /**
   * Dispatch an inbound message to an ACP session.
   *
   * @returns The dispatch result containing session key and metadata
   * @throws Error if no valid session can be resolved
   */
  async dispatch(params: {
    message: InboundMessage;
    sessionKey?: string;
  }): Promise<AcpDispatchResult> {
    const { message, sessionKey } = params;

    const policyError = resolveAcpDispatchPolicyError(this.config);
    if (policyError) {
      throw policyError;
    }

    const resolvedSessionKey = await this.resolveSessionKeyForMessage({
      message,
      sessionKey,
    });

    if (!resolvedSessionKey) {
      throw new Error(`Could not resolve ACP session key for message: ${message.id}`);
    }

    const sessionEntry = readAcpSessionEntry({ sessionKey: resolvedSessionKey });
    if (!sessionEntry?.acp) {
      throw new Error(
        `Session "${resolvedSessionKey}" is missing ACP metadata. Recreate/bind an ACP session first.`,
      );
    }

    const meta = sessionEntry.acp;

    if (meta.state === "error") {
      throw new Error(`Session "${resolvedSessionKey}" is in error state: ${meta.lastError}`);
    }

    const now = Date.now();
    const nextMeta = upsertAcpSessionMeta({
      sessionKey: resolvedSessionKey,
      mutate: (current) => {
        if (!current) {
          return null;
        }
        return {
          ...current,
          state: "running",
          lastActivityAt: now,
          lastError: undefined,
        };
      },
    });

    this.bindMessageToSession({
      messageId: message.id,
      sessionKey: resolvedSessionKey,
      channelId: message.channel,
      peerId: message.peerId,
      threadId: message.threadId,
    });

    return {
      sessionKey: resolvedSessionKey,
      meta: nextMeta ?? meta,
      messageId: message.id,
    };
  }

  /**
   * Send a message to the resolved ACP session and return an async iterable of events.
   */
  async sendMessage(params: {
    sessionKey: string;
    text: string;
    attachments?: Array<{ type: string; mimeType: string; content: string }>;
    signal?: AbortSignal;
  }): Promise<AsyncIterable<AcpBridgeEvent>> {
    return this.adapter.sendMessage(params);
  }

  /**
   * Dispatch inbound message and project ACP runtime events to outbound payloads.
   */
  async *dispatchAndProject(params: {
    message: InboundMessage;
    sessionKey?: string;
    signal?: AbortSignal;
    projectorConfig?: AcpReplyProjectorConfig;
  }): AsyncGenerator<AcpProjectedReply, void, unknown> {
    const { message, sessionKey, signal, projectorConfig } = params;
    const dispatchResult = await this.dispatch({ message, sessionKey });
    const events = await this.sendMessage({
      sessionKey: dispatchResult.sessionKey,
      text: message.text ?? "",
      signal,
    });

    const projector = createAcpReplyProjector({
      context: {
        sessionKey: dispatchResult.sessionKey,
        channelId: message.channel,
        peerId: message.peerId,
        messageId: message.id,
        replyToId: message.replyToId,
        threadId: message.threadId,
      },
      config: {
        coalesceIdleMs: projectorConfig?.coalesceIdleMs ?? this.config.acp?.stream?.coalesceIdleMs,
        maxChunkChars: projectorConfig?.maxChunkChars ?? this.config.acp?.stream?.maxChunkChars,
      },
    });

    for await (const projected of projector.projectStream(events)) {
      yield projected;
    }
  }

  /**
   * Abort an in-progress session run.
   */
  async abortSession(sessionKey: string): Promise<void> {
    await this.adapter.abortSession(sessionKey);
  }

  /**
   * Check if a session key is an ACP session.
   */
  isAcpSession(sessionKey: string): boolean {
    return isAcpSessionKey(sessionKey) || sessionKey.includes(":");
  }

  private pruneBindings(): void {
    const ttlMs = this.config.acp?.dispatch?.messageBindingTtlMs ?? DEFAULT_BINDING_TTL_MS;
    const cutoff = Date.now() - ttlMs;

    // TTL eviction for messageToSession
    for (const [key, binding] of this.messageToSession) {
      if (binding.boundAt < cutoff) {
        this.messageToSession.delete(key);
      }
    }
    // FIFO safety net
    while (this.messageToSession.size > MAX_BINDINGS) {
      const firstKey = this.messageToSession.keys().next().value;
      if (!firstKey) {
        break;
      }
      this.messageToSession.delete(firstKey);
    }

    // TTL eviction for conversationToSession
    for (const [key, boundAt] of this.conversationBoundAt) {
      if (boundAt < cutoff) {
        this.conversationToSession.delete(key);
        this.conversationBoundAt.delete(key);
      }
    }
    // FIFO safety net
    while (this.conversationToSession.size > MAX_BINDINGS) {
      const firstKey = this.conversationToSession.keys().next().value;
      if (!firstKey) {
        break;
      }
      this.conversationToSession.delete(firstKey);
      this.conversationBoundAt.delete(firstKey);
    }
  }
}

/**
 * Creates a new ACP dispatch pipeline instance.
 */
export function createAcpDispatchPipeline(params: {
  config: MoziConfig;
  adapter: AcpBridgeRuntimeAdapter;
}): AcpDispatchPipeline {
  return new AcpDispatchPipeline(params);
}
