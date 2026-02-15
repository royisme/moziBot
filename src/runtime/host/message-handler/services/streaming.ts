/**
 * Streaming Service
 * 
 * Manages character-and-time-based debounce for message updates and 
 * handles mapping of agent session events to streaming callbacks.
 */

export interface StreamEvent {
  readonly type: 'text_delta' | 'tool_start' | 'tool_end' | 'agent_end';
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
      assistantMessageEvent: { type: "text_delta"; delta: string } 
    }
  | { 
      type: "tool_execution_start"; 
      toolName: string; 
      toolCallId: string 
    }
  | { 
      type: "tool_execution_end"; 
      toolName: string; 
      toolCallId: string; 
      isError: boolean 
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
  updateAccumulated: (text: string) => void
): Promise<void> {
  if (event.type === 'message_update') {
    const assistantEvent = event.assistantMessageEvent;
    if (assistantEvent.type === 'text_delta') {
      updateAccumulated(assistantEvent.delta);
      await onStream({ type: 'text_delta', delta: assistantEvent.delta });
    }
  } else if (event.type === 'tool_execution_start') {
    await onStream({ 
      type: 'tool_start', 
      toolName: event.toolName, 
      toolCallId: event.toolCallId 
    });
  } else if (event.type === 'tool_execution_end') {
    await onStream({ 
      type: 'tool_end', 
      toolName: event.toolName, 
      toolCallId: event.toolCallId, 
      isError: event.isError 
    });
  }
}

/**
 * Char-and-time based debounce buffer for streaming updates.
 * Preserves monolith behavior parity (500ms, 50 chars, check !this.buffer).
 */
export class StreamingBuffer {
  private static readonly FLUSH_INTERVAL_MS = 500;
  private static readonly MIN_CHARS_TO_FLUSH = 50;

  private buffer = '';
  private lastFlushTime = Date.now();
  private messageId: string | null = null;
  private flushTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly channel: StreamingBufferChannel,
    private readonly peerId: string,
    private readonly onError?: (err: Error) => void,
    private readonly traceId?: string,
  ) {}

  /**
   * Initializes the stream by sending a placeholder.
   */
  async initialize(): Promise<void> {
    try {
      this.messageId = await this.channel.send(this.peerId, { text: '⏳', traceId: this.traceId });
    } catch (error) {
      this.handleError(error);
    }
  }

  /**
   * Appends text and schedules a potential flush.
   */
  append(text: string): void {
    this.buffer += text;
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
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
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }

    // Monolith parity: check !this.buffer (NOT trim)
    if (!this.messageId || !this.buffer) {
      return;
    }

    try {
      await this.channel.editMessage(this.messageId, this.peerId, this.buffer);
      this.lastFlushTime = Date.now();
    } catch (error) {
      this.handleError(error);
    }
  }

  /**
   * Finalizes the stream with the full text.
   */
  async finalize(finalText?: string): Promise<string | null> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }

    if (!this.messageId) {
      return null;
    }

    const textToSend = finalText || this.buffer || '(no response)';

    try {
      await this.channel.editMessage(this.messageId, this.peerId, textToSend);
      return this.messageId;
    } catch (error) {
      this.handleError(error);
      return this.messageId;
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
