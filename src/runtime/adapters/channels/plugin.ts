import { EventEmitter } from "node:events";
import type {
  ChannelActionQueryContext,
  ChannelActionSpec,
  ChannelCapabilities,
  ChannelStatus,
  InboundMessage,
  OutboundMessage,
  StatusReaction,
  StatusReactionPayload,
} from "./types";

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
  getCapabilities(): ChannelCapabilities;
  listActions?(context?: ChannelActionQueryContext): ChannelActionSpec[];
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
  setStatusReaction?(
    peerId: string,
    messageId: string,
    status: StatusReaction,
    payload?: StatusReactionPayload,
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

  getCapabilities(): ChannelCapabilities {
    return {
      media: false,
      polls: false,
      reactions: false,
      threads: false,
      editMessage: false,
      deleteMessage: false,
      implicitCurrentTarget: true,
      supportedActions: ["send_text", "reply"],
    };
  }

  listActions(context?: ChannelActionQueryContext): ChannelActionSpec[] {
    const supported = new Set(this.getCapabilities().supportedActions);
    const actions: ChannelActionSpec[] = [
      {
        name: "send_text",
        enabled: supported.has("send_text"),
        description: "Send text to the current conversation.",
      },
      {
        name: "send_media",
        enabled: supported.has("send_media"),
        description: "Send media attachments to the current conversation.",
      },
      {
        name: "reply",
        enabled: supported.has("reply"),
        description: "Reply in the current conversation or thread.",
      },
    ];
    return actions.filter((spec) => spec.enabled || context !== undefined);
  }

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

  /**
   * Public method to emit messages from external handlers (like slash commands)
   */
  public emitInboundMessage(msg: InboundMessage): void {
    this.emit("message", msg);
  }

  protected emitError(error: Error): void {
    if (this.listenerCount("error") === 0) {
      return;
    }
    this.emit("error", error);
  }
}
