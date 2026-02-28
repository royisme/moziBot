import type { OutboundMessage } from "../../runtime/adapters/channels/types";

/**
 * Event types from ACP runtime that need to be projected.
 */
export type AcpProjectableEvent =
  | { type: "text_delta"; text: string }
  | { type: "tool_use"; name: string; args?: Record<string, unknown> }
  | { type: "tool_result"; name: string; output?: string }
  | { type: "done"; stopReason?: string }
  | { type: "error"; message: string };

/**
 * Context for projecting replies back to the messaging platform.
 */
export interface AcpReplyContext {
  sessionKey: string;
  channelId: string;
  peerId: string;
  replyToId?: string;
  threadId?: string | number;
  messageId?: string;
}

/**
 * Configuration for the reply projector.
 */
export interface AcpReplyProjectorConfig {
  /**
   * Coalesce text deltas within this window (ms) before emitting.
   * Reserved for future idle-time flush behavior.
   */
  coalesceIdleMs?: number;
  /**
   * Maximum characters per text chunk.
   */
  maxChunkChars?: number;
}

/**
 * Projected reply result containing the outbound message and metadata.
 */
export interface AcpProjectedReply {
  outbound: OutboundMessage;
  context: AcpReplyContext;
  isFinal: boolean;
  stopReason?: string;
}

function normalizeMaxChunkChars(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 1800;
  }
  const rounded = Math.round(value);
  if (rounded < 50) return 50;
  if (rounded > 4000) return 4000;
  return rounded;
}

function formatToolArgs(args?: Record<string, unknown>): string {
  if (!args || Object.keys(args).length === 0) {
    return "";
  }
  const pairs = Object.entries(args).map(([key, value]) => `${key}=${JSON.stringify(value)}`);
  return `(${pairs.join(", ")})`;
}

/**
 * ACP Reply Projector
 *
 * Projects ACP session responses back to the messaging platform.
 * Handles event streaming, chunking, and platform threading/reply projection.
 */
export class AcpReplyProjector {
  private readonly config: AcpReplyProjectorConfig;
  private readonly context: AcpReplyContext;
  private readonly pending: AcpProjectedReply[] = [];
  private buffer = "";
  private resolved = false;

  constructor(params: { context: AcpReplyContext; config?: AcpReplyProjectorConfig }) {
    this.context = params.context;
    this.config = {
      coalesceIdleMs: params.config?.coalesceIdleMs ?? 350,
      maxChunkChars: normalizeMaxChunkChars(params.config?.maxChunkChars),
    };
  }

  /**
   * Project a single ACP event.
   * Returns one projected reply when available; additional replies are queued internally.
   */
  project(event: AcpProjectableEvent): AcpProjectedReply | null {
    if (this.resolved) {
      return this.dequeue();
    }

    switch (event.type) {
      case "text_delta":
        this.handleTextDelta(event.text);
        break;
      case "tool_use":
        this.handleToolUse(event.name, event.args);
        break;
      case "tool_result":
        this.handleToolResult(event.name, event.output);
        break;
      case "done":
        this.handleDone(event.stopReason);
        break;
      case "error":
        this.handleError(event.message);
        break;
      default:
        break;
    }

    return this.dequeue();
  }

  /**
   * Process an async iterable of ACP events and yield projected replies.
   */
  async *projectStream(
    events: AsyncIterable<AcpProjectableEvent>,
  ): AsyncGenerator<AcpProjectedReply, void, unknown> {
    for await (const event of events) {
      const first = this.project(event);
      if (first) {
        yield first;
      }

      let next = this.dequeue();
      while (next) {
        yield next;
        next = this.dequeue();
      }

      if (this.resolved) {
        break;
      }
    }

    const tail = this.flush();
    if (tail) {
      yield tail;
    }

    let next = this.dequeue();
    while (next) {
      yield next;
      next = this.dequeue();
    }
  }

  /**
   * Flush remaining buffered text into a projected reply.
   */
  flush(): AcpProjectedReply | null {
    this.flushTextBuffer(false);
    return this.dequeue();
  }

  getContext(): AcpReplyContext {
    return this.context;
  }

  private dequeue(): AcpProjectedReply | null {
    return this.pending.shift() ?? null;
  }

  private enqueue(outbound: OutboundMessage, isFinal: boolean, stopReason?: string): void {
    this.pending.push({
      outbound: {
        ...outbound,
        replyToId: this.context.replyToId,
        threadId: this.context.threadId,
      },
      context: this.context,
      isFinal,
      stopReason,
    });
  }

  private handleTextDelta(text: string): void {
    if (!text) {
      return;
    }
    this.buffer += text;
    this.flushTextBuffer(false);
  }

  private flushTextBuffer(force: boolean): void {
    const max = this.config.maxChunkChars ?? 1800;
    while (this.buffer.length >= max) {
      const chunk = this.buffer.slice(0, max);
      this.buffer = this.buffer.slice(max);
      this.enqueue({ text: chunk }, false);
    }

    if (force && this.buffer.length > 0) {
      this.enqueue({ text: this.buffer }, false);
      this.buffer = "";
    }
  }

  private handleToolUse(name: string, args?: Record<string, unknown>): void {
    this.flushTextBuffer(true);
    const descriptor = `${name}${formatToolArgs(args)}`;
    this.enqueue({ text: `[Tool: ${descriptor}]` }, false);
  }

  private handleToolResult(name: string, output?: string): void {
    this.flushTextBuffer(true);
    const summary = output
      ? `[Tool ${name} result: ${output.slice(0, 500)}]`
      : `[Tool ${name} completed]`;
    this.enqueue({ text: summary }, false);
  }

  private handleDone(stopReason?: string): void {
    this.flushTextBuffer(true);
    this.resolved = true;

    if (this.pending.length > 0) {
      const last = this.pending[this.pending.length - 1];
      this.pending[this.pending.length - 1] = {
        ...last,
        isFinal: true,
        stopReason,
      };
      return;
    }

    this.enqueue({ text: "" }, true, stopReason);
  }

  private handleError(message: string): void {
    this.flushTextBuffer(true);
    this.resolved = true;
    this.enqueue({ text: `[Error: ${message}]` }, true, "error");
  }
}

/**
 * Creates a new ACP reply projector instance.
 */
export function createAcpReplyProjector(params: {
  context: AcpReplyContext;
  config?: AcpReplyProjectorConfig;
}): AcpReplyProjector {
  return new AcpReplyProjector(params);
}

/**
 * Utility function to project a complete ACP event stream to a single response.
 * Use this for non-streaming responses.
 */
export async function projectToSingleReply(
  events: AsyncIterable<AcpProjectableEvent>,
  context: AcpReplyContext,
  config?: AcpReplyProjectorConfig,
): Promise<OutboundMessage> {
  const projector = new AcpReplyProjector({ context, config });
  let finalText = "";

  for await (const projected of projector.projectStream(events)) {
    if (projected.outbound.text) {
      finalText += projected.outbound.text;
    }
  }

  return {
    text: finalText || "(no response)",
    replyToId: context.replyToId,
    threadId: context.threadId,
  };
}
