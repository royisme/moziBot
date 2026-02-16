export interface StreamEvent {
  readonly type: "text_delta" | "tool_start" | "tool_end" | "agent_end";
  readonly delta?: string;
  readonly toolName?: string;
  readonly toolCallId?: string;
  readonly isError?: boolean;
  readonly fullText?: string;
}

export type StreamingCallback = (event: StreamEvent) => void | Promise<void>;

/**
 * Explicit subset of AgentSessionEvent from monolith handling.
 */
export type AgentSessionEvent =
  | {
      type: "message_update";
      assistantMessageEvent: { type: "text_delta"; delta: string };
    }
  | {
      type: "tool_execution_start";
      toolName: string;
      toolCallId: string;
    }
  | {
      type: "tool_execution_end";
      toolName: string;
      toolCallId: string;
      isError: boolean;
    };

export interface StreamingBufferChannel {
  send(peerId: string, payload: { text: string; traceId?: string }): Promise<string>;
  editMessage(messageId: string, peerId: string, text: string): Promise<void>;
}

/**
 * Maps AgentSessionEvent to StreamingCallback events.
 * Preserves monolith event mapping logic and property names exactly.
 */
export async function handleAgentStreamEvent(
  event: AgentSessionEvent,
  onStream: StreamingCallback,
  updateAccumulated: (text: string) => void,
): Promise<void> {
  if (event.type === "message_update") {
    const assistantEvent = event.assistantMessageEvent;
    if (assistantEvent.type === "text_delta") {
      updateAccumulated(assistantEvent.delta);
      await onStream({ type: "text_delta", delta: assistantEvent.delta });
    }
  } else if (event.type === "tool_execution_start") {
    await onStream({
      type: "tool_start",
      toolName: event.toolName,
      toolCallId: event.toolCallId,
    });
  } else if (event.type === "tool_execution_end") {
    await onStream({
      type: "tool_end",
      toolName: event.toolName,
      toolCallId: event.toolCallId,
      isError: event.isError,
    });
  }
}

/**
 * Char-and-time based debounce buffer for streaming updates.
 * Preserves monolith behavior parity (500ms, 50 chars, check !this.buffer).
 */
export class StreamingBuffer {
  private static readonly FLUSH_INTERVAL_MS = 1000;
  private static readonly MIN_CHARS_TO_FLUSH = 50;

  private buffer = "";
  private lastFlushTime = Date.now();
  private lastSentText = "";
  private messageId: string | null = null;
  private flushTimer: NodeJS.Timeout | null = null;
  private streamFailed = false;
  private finalized = false;
  private inFlight: Promise<void> = Promise.resolve();

  constructor(
    private readonly channel: StreamingBufferChannel,
    private readonly peerId: string,
    private readonly onError?: (err: Error) => void,
    private readonly traceId?: string,
  ) {}

  async initialize(): Promise<void> {
    return;
  }

  /**
   * Appends text and schedules a potential flush.
   */
  append(text: string): void {
    if (this.finalized || !text) {
      return;
    }
    this.buffer += text;
    this.scheduleFlush(this.messageId === null);
  }

  private scheduleFlush(forceImmediate = false): void {
    if (this.finalized) {
      return;
    }

    if (forceImmediate) {
      void this.flush();
      return;
    }

    if (this.flushTimer) {
      return;
    }

    const timeSinceFlush = Date.now() - this.lastFlushTime;
    const shouldFlushNow =
      this.buffer.length >= StreamingBuffer.MIN_CHARS_TO_FLUSH &&
      timeSinceFlush >= StreamingBuffer.FLUSH_INTERVAL_MS;

    if (shouldFlushNow) {
      void this.flush();
    } else {
      const delay = Math.max(0, StreamingBuffer.FLUSH_INTERVAL_MS - timeSinceFlush);
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null;
        void this.flush();
      }, delay);
    }
  }

  private async flush(): Promise<void> {
    if (this.finalized) {
      return;
    }

    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }

    if (!this.buffer) {
      return;
    }

    const targetText = this.buffer;

    this.inFlight = this.inFlight.then(async () => {
      if (this.finalized || this.streamFailed) {
        return;
      }

      try {
        if (!this.messageId) {
          this.messageId = await this.channel.send(this.peerId, {
            text: targetText,
            traceId: this.traceId,
          });
        } else if (targetText !== this.lastSentText) {
          await this.channel.editMessage(this.messageId, this.peerId, targetText);
        }

        this.lastSentText = targetText;
        this.lastFlushTime = Date.now();
      } catch (error) {
        this.streamFailed = true;
        this.handleError(error);
      }
    });

    await this.inFlight;
  }

  /**
   * Finalizes the stream with the full text.
   */
  async finalize(finalText?: string): Promise<string | null> {
    this.finalized = true;

    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }

    try {
      await this.inFlight;
    } catch (error) {
      this.handleError(error);
    }

    const textToSend = (finalText || this.buffer || "").trim();

    if (!textToSend) {
      return this.messageId;
    }

    if (!this.messageId) {
      try {
        this.messageId = await this.channel.send(this.peerId, {
          text: textToSend,
          traceId: this.traceId,
        });
        this.lastSentText = textToSend;
        return this.messageId;
      } catch (error) {
        this.handleError(error);
        return null;
      }
    }

    if (this.lastSentText === textToSend && !this.streamFailed) {
      return this.messageId;
    }

    try {
      await this.channel.editMessage(this.messageId, this.peerId, textToSend);
      this.lastSentText = textToSend;
      return this.messageId;
    } catch (error) {
      this.handleError(error);
      try {
        const fallbackId = await this.channel.send(this.peerId, {
          text: textToSend,
          traceId: this.traceId,
        });
        this.messageId = fallbackId;
        this.lastSentText = textToSend;
        return fallbackId;
      } catch (sendError) {
        this.handleError(sendError);
        return this.messageId;
      }
    }
  }

  getAccumulatedText(): string {
    return this.buffer;
  }

  private handleError(error: unknown): void {
    if (this.onError) {
      this.onError(error instanceof Error ? error : new Error(String(error)));
    }
  }
}
