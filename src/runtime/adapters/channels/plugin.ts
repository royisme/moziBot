import { EventEmitter } from "node:events";
import type { ChannelStatus, InboundMessage, OutboundMessage } from "./types";

export interface ChannelPlugin extends EventEmitter {
  readonly id: string;
  readonly name: string;

  // Lifecycle
  connect(): Promise<void>;
  disconnect(): Promise<void>;

  // Status
  getStatus(): ChannelStatus;
  isConnected(): boolean;

  // Messaging
  send(peerId: string, message: OutboundMessage): Promise<string>; // Returns message ID
  beginTyping?(peerId: string): Promise<(() => Promise<void> | void) | void>;
  editMessage?(messageId: string, peerId: string, newText: string): Promise<void>;
  emitPhase?(
    peerId: string,
    phase: "idle" | "listening" | "thinking" | "speaking" | "executing" | "error",
    payload?: {
      sessionKey?: string;
      agentId?: string;
      toolName?: string;
      toolCallId?: string;
      messageId?: string;
    },
  ): Promise<void>;

  // Events (via EventEmitter)
  // 'message' - (msg: InboundMessage) => void
  // 'error' - (error: Error) => void
  // 'status' - (status: ChannelStatus) => void
}

// Base class with common functionality
export abstract class BaseChannelPlugin extends EventEmitter implements ChannelPlugin {
  abstract readonly id: string;
  abstract readonly name: string;
  protected status: ChannelStatus = "disconnected";

  abstract connect(): Promise<void>;
  abstract disconnect(): Promise<void>;
  abstract send(peerId: string, message: OutboundMessage): Promise<string>;

  getStatus(): ChannelStatus {
    return this.status;
  }

  isConnected(): boolean {
    return this.status === "connected";
  }

  protected setStatus(status: ChannelStatus): void {
    this.status = status;
    this.emit("status", status);
  }

  protected emitMessage(msg: InboundMessage): void {
    this.emit("message", msg);
  }

  protected emitError(error: Error): void {
    if (this.listenerCount("error") === 0) {
      return;
    }
    this.emit("error", error);
  }
}
