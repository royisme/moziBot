import type { Bot } from "grammy";
import { logger } from "../../../../logger";
import { editMsg, sendMessage } from "./send";
import type { OutboundMessage } from "../types";

/**
 * Lane names for content separation
 */
export type LaneName = "answer" | "reasoning";

/**
 * State for a single draft lane
 */
interface DraftLaneState {
  messageId: string | null;
  lastText: string;
  finalized: boolean;
}

/**
 * Archived preview message that can be cleaned up
 */
interface ArchivedPreview {
  lane: LaneName;
  messageId: string;
  generation: number;
}

/**
 * Configuration for lane delivery
 */
export interface LaneDeliveryConfig {
  /** Throttle interval for updates in ms (default: 1000) */
  throttleMs?: number;
  /** Enable debug logging */
  debug?: boolean;
}

/**
 * Lane delivery state tracker
 */
interface LaneDeliveryState {
  lanes: Record<LaneName, DraftLaneState>;
  currentGeneration: number;
  archivedPreviews: ArchivedPreview[];
}

/**
 * Create a lane delivery state tracker
 */
export function createLaneDeliveryStateTracker(): LaneDeliveryState {
  return {
    lanes: {
      answer: { messageId: null, lastText: "", finalized: false },
      reasoning: { messageId: null, lastText: "", finalized: false },
    },
    currentGeneration: 0,
    archivedPreviews: [],
  };
}

/**
 * Lane text deliverer - handles message creation/editing for a lane
 */
export interface LaneTextDeliverer {
  /**
   * Update text for a specific lane
   */
  updateLane(lane: LaneName, text: string): Promise<void>;

  /**
   * Finalize a lane (mark as complete)
   */
  finalizeLane(lane: LaneName): Promise<void>;

  /**
   * Get all archived preview message IDs
   */
  getArchivedPreviews(): ArchivedPreview[];

  /**
   * Clear all drafts and archives
   */
  clearAll(): Promise<void>;

  /**
   * Get current message ID for a lane
   */
  getLaneMessageId(lane: LaneName): string | null;
}

/**
 * Create a lane text deliverer for Telegram
 */
export function createLaneTextDeliverer(
  bot: Bot,
  peerId: string,
  config?: LaneDeliveryConfig,
): LaneTextDeliverer {
  const throttleMs = config?.throttleMs ?? 1000;
  const debug = config?.debug ?? false;

  const state = createLaneDeliveryStateTracker();

  // Throttle state per lane
  const pendingUpdates = new Map<LaneName, string>();
  const throttleTimeouts = new Map<LaneName, ReturnType<typeof setTimeout>>();

  async function flushLaneUpdate(lane: LaneName): Promise<void> {
    const text = pendingUpdates.get(lane);
    if (!text) {
      return;
    }

    pendingUpdates.delete(lane);
    const timeout = throttleTimeouts.get(lane);
    if (timeout) {
      clearTimeout(timeout);
      throttleTimeouts.delete(lane);
    }

    const laneState = state.lanes[lane];

    try {
      if (!laneState.messageId) {
        // First message - send new message
        const message: OutboundMessage = { text };
        laneState.messageId = await sendMessage(bot, peerId, message, "");
        laneState.lastText = text;
        if (debug) {
          logger.debug({ lane, messageId: laneState.messageId, textLength: text.length }, "Lane message sent");
        }
      } else if (!laneState.finalized) {
        // Subsequent updates - edit existing message
        await editMsg(bot, laneState.messageId, peerId, text);
        laneState.lastText = text;
        if (debug) {
          logger.debug({ lane, messageId: laneState.messageId, textLength: text.length }, "Lane message updated");
        }
      }
    } catch (error) {
      logger.error({ error, lane }, "Lane update failed");
      // If edit fails, try sending a new message
      try {
        const message: OutboundMessage = { text };
        laneState.messageId = await sendMessage(bot, peerId, message, "");
        laneState.lastText = text;
      } catch (sendError) {
        logger.error({ error: sendError, lane }, "Lane send failed");
      }
    }
  }

  function scheduleLaneUpdate(lane: LaneName, text: string): void {
    pendingUpdates.set(lane, text);

    const existingTimeout = throttleTimeouts.get(lane);
    if (existingTimeout) {
      clearTimeout(existingTimeout);
    }

    throttleTimeouts.set(
      lane,
      setTimeout(() => flushLaneUpdate(lane), throttleMs),
    );
  }

  async function deleteLaneMessage(lane: LaneName): Promise<void> {
    const laneState = state.lanes[lane];
    if (laneState.messageId) {
      try {
        await bot.api.deleteMessage(peerId, parseInt(laneState.messageId));
      } catch (error) {
        logger.warn({ error, lane, messageId: laneState.messageId }, "Failed to delete lane message");
      }
      // Archive for potential cleanup
      state.archivedPreviews.push({
        lane,
        messageId: laneState.messageId,
        generation: state.currentGeneration,
      });
      laneState.messageId = null;
      laneState.lastText = "";
    }
  }

  return {
    async updateLane(lane: LaneName, text: string): Promise<void> {
      scheduleLaneUpdate(lane, text);
    },

    async finalizeLane(lane: LaneName): Promise<void> {
      // Flush pending update
      const text = pendingUpdates.get(lane);
      if (text) {
        await flushLaneUpdate(lane);
      }

      // Mark as finalized
      state.lanes[lane].finalized = true;

      if (debug) {
        logger.debug({ lane, messageId: state.lanes[lane].messageId }, "Lane finalized");
      }
    },

    getArchivedPreviews(): ArchivedPreview[] {
      return [...state.archivedPreviews];
    },

    async clearAll(): Promise<void> {
      // Clear all timeouts
      for (const timeout of throttleTimeouts.values()) {
        clearTimeout(timeout);
      }
      pendingUpdates.clear();
      throttleTimeouts.clear();

      // Delete all lane messages
      for (const lane of Object.keys(state.lanes) as LaneName[]) {
        await deleteLaneMessage(lane);
      }

      // Delete archived previews from current generation (keep finalized ones)
      const toDelete = state.archivedPreviews.filter(
        (p) => p.generation === state.currentGeneration,
      );
      for (const preview of toDelete) {
        try {
          await bot.api.deleteMessage(peerId, parseInt(preview.messageId));
        } catch (error) {
          logger.warn({ error, preview }, "Failed to delete archived preview");
        }
      }
      state.archivedPreviews = state.archivedPreviews.filter(
        (p) => p.generation !== state.currentGeneration,
      );

      // Reset generation
      state.currentGeneration++;

      if (debug) {
        logger.debug("All lanes cleared");
      }
    },

    getLaneMessageId(lane: LaneName): string | null {
      return state.lanes[lane].messageId;
    },
  };
}

/**
 * Manager for lane delivery (one per peer/conversation)
 */
export class LaneDeliveryManager {
  private deliverers = new Map<string, LaneTextDeliverer>();
  private bot: Bot;
  private config: LaneDeliveryConfig;

  constructor(bot: Bot, config?: LaneDeliveryConfig) {
    this.bot = bot;
    this.config = config ?? {};
  }

  /**
   * Get or create a deliverer for a peer
   */
  getOrCreate(peerId: string): LaneTextDeliverer {
    let deliverer = this.deliverers.get(peerId);
    if (!deliverer) {
      deliverer = createLaneTextDeliverer(this.bot, peerId, this.config);
      this.deliverers.set(peerId, deliverer);
    }
    return deliverer;
  }

  /**
   * Get existing deliverer (does not create)
   */
  get(peerId: string): LaneTextDeliverer | undefined {
    return this.deliverers.get(peerId);
  }

  /**
   * Remove and clear a deliverer for a peer
   */
  async remove(peerId: string): Promise<void> {
    const deliverer = this.deliverers.get(peerId);
    if (deliverer) {
      await deliverer.clearAll();
      this.deliverers.delete(peerId);
    }
  }

  /**
   * Clear all deliverers
   */
  async clearAll(): Promise<void> {
    for (const peerId of this.deliverers.keys()) {
      await this.remove(peerId);
    }
  }
}
