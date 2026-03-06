import type { Bot } from "grammy";
import { logger } from "../../../../logger";
import type { OutboundMessage } from "../types";
import { editMsg, sendMessage } from "./send";

/**
 * Telegram Draft Stream configuration
 */
export interface TelegramDraftStreamConfig {
  /** Throttle interval in milliseconds (default: 1000) */
  throttleMs?: number;
  /** Enable debug logging */
  debug?: boolean;
}

/**
 * Telegram draft stream for real-time message updates
 *
 * Uses editMessageText to update a message in place, providing a "draft" effect
 * where users see the response appear and update in real-time.
 */
export interface TelegramDraftStream {
  /**
   * Update the draft message with new content
   */
  update(text: string): Promise<void>;

  /**
   * Force creation of a new message instead of editing the current one
   */
  forceNewMessage(): Promise<void>;

  /**
   * Finalize the draft - convert to a regular message
   * @returns The final message ID
   */
  materialize(): Promise<string>;

  /**
   * Clear/destroy the draft without materializing
   */
  clear(): Promise<void>;

  /**
   * Stop the stream (alias for clear)
   */
  stop(): Promise<void>;
}

/**
 * Transport layer for draft stream messages
 */
interface MessageTransport {
  send(text: string): Promise<string>; // Returns message ID
  edit(messageId: string, text: string): Promise<void>;
  delete(messageId: string): Promise<void>;
}

/**
 * Internal state for a draft stream generation
 */
interface Generation {
  messageId: string | null;
  lastText: string;
  finalized: boolean;
}

/**
 * Create a Telegram draft stream for real-time message updates
 */
export function createTelegramDraftStream(
  bot: Bot,
  peerId: string,
  config?: TelegramDraftStreamConfig,
): TelegramDraftStream {
  const throttleMs = config?.throttleMs ?? 1000;
  const debug = config?.debug ?? false;

  let transport: MessageTransport;
  let currentGeneration: Generation = {
    messageId: null,
    lastText: "",
    finalized: false,
  };

  // Throttle state
  let pendingUpdate: string | null = null;
  let throttleTimeout: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  // Transport that uses editMessageText (message mode)
  // Note: Draft mode (sendMessageDraft) is only available in DMs and is more complex
  // For broader compatibility, we use editMessageText which works in both DMs and groups
  transport = {
    async send(text: string): Promise<string> {
      const message: OutboundMessage = { text };
      return sendMessage(bot, peerId, message, "");
    },

    async edit(messageId: string, text: string): Promise<void> {
      await editMsg(bot, messageId, peerId, text);
    },

    async delete(messageId: string): Promise<void> {
      try {
        await bot.api.deleteMessage(peerId, parseInt(messageId));
      } catch (error) {
        logger.warn({ error, messageId }, "Failed to delete draft message");
      }
    },
  };

  async function flushUpdate(): Promise<void> {
    if (!pendingUpdate || stopped) {
      return;
    }

    const text = pendingUpdate;
    pendingUpdate = null;
    throttleTimeout = null;

    try {
      if (!currentGeneration.messageId) {
        // First message - send new message
        currentGeneration.messageId = await transport.send(text);
        currentGeneration.lastText = text;
        if (debug) {
          logger.debug(
            { messageId: currentGeneration.messageId, textLength: text.length },
            "Draft sent",
          );
        }
      } else if (!currentGeneration.finalized) {
        // Subsequent updates - edit existing message
        await transport.edit(currentGeneration.messageId, text);
        currentGeneration.lastText = text;
        if (debug) {
          logger.debug(
            { messageId: currentGeneration.messageId, textLength: text.length },
            "Draft updated",
          );
        }
      }
    } catch (error) {
      logger.error({ error }, "Draft stream update failed");
      // If edit fails, try sending a new message
      try {
        currentGeneration.messageId = await transport.send(text);
        currentGeneration.lastText = text;
      } catch (sendError) {
        logger.error({ error: sendError }, "Draft stream send failed");
      }
    }
  }

  function scheduleUpdate(text: string): void {
    if (stopped) {
      return;
    }

    pendingUpdate = text;

    if (throttleTimeout) {
      clearTimeout(throttleTimeout);
    }

    throttleTimeout = setTimeout(flushUpdate, throttleMs);
  }

  return {
    async update(text: string): Promise<void> {
      if (stopped) {
        return;
      }
      scheduleUpdate(text);
    },

    async forceNewMessage(): Promise<void> {
      if (stopped) {
        return;
      }

      // Delete current message if exists
      if (currentGeneration.messageId) {
        await transport.delete(currentGeneration.messageId);
      }

      // Start new generation
      currentGeneration = {
        messageId: null,
        lastText: currentGeneration.lastText,
        finalized: false,
      };

      // Immediately flush any pending update
      if (pendingUpdate) {
        await flushUpdate();
      }
    },

    async materialize(): Promise<string> {
      // Flush any pending updates
      if (pendingUpdate) {
        await flushUpdate();
      }

      // Mark as finalized to prevent further edits
      currentGeneration.finalized = true;

      const messageId = currentGeneration.messageId;
      if (!messageId) {
        throw new Error("Cannot materialize: no message was created");
      }

      if (debug) {
        logger.debug({ messageId }, "Draft materialized");
      }

      return messageId;
    },

    async clear(): Promise<void> {
      stopped = true;

      // Clear any pending throttle
      if (throttleTimeout) {
        clearTimeout(throttleTimeout);
        throttleTimeout = null;
      }

      // Delete the draft message if exists
      if (currentGeneration.messageId) {
        await transport.delete(currentGeneration.messageId);
        currentGeneration.messageId = null;
      }

      pendingUpdate = null;

      if (debug) {
        logger.debug("Draft cleared");
      }
    },

    async stop(): Promise<void> {
      return this.clear();
    },
  };
}

/**
 * Manager for multiple draft streams (one per peer/conversation)
 */
export class DraftStreamManager {
  private streams = new Map<string, TelegramDraftStream>();
  private bot: Bot;
  private config: TelegramDraftStreamConfig;

  constructor(bot: Bot, config?: TelegramDraftStreamConfig) {
    this.bot = bot;
    this.config = config ?? {};
  }

  /**
   * Get or create a draft stream for a peer
   */
  getOrCreate(peerId: string): TelegramDraftStream {
    let stream = this.streams.get(peerId);
    if (!stream) {
      stream = createTelegramDraftStream(this.bot, peerId, this.config);
      this.streams.set(peerId, stream);
    }
    return stream;
  }

  /**
   * Get existing stream for a peer (does not create)
   */
  get(peerId: string): TelegramDraftStream | undefined {
    return this.streams.get(peerId);
  }

  /**
   * Remove and clear a stream for a peer
   */
  async remove(peerId: string): Promise<void> {
    const stream = this.streams.get(peerId);
    if (stream) {
      await stream.clear();
      this.streams.delete(peerId);
    }
  }

  /**
   * Clear all streams
   */
  async clearAll(): Promise<void> {
    for (const peerId of this.streams.keys()) {
      await this.remove(peerId);
    }
  }
}
