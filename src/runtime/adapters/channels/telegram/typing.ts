import { logger } from "../../../../logger";

const TYPING_INTERVAL_MS = 6_000;
const TYPING_TTL_MS = 2 * 60_000;

// 401 backoff configuration
const INITIAL_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 300_000; // 5 minutes
const MAX_CONSECUTIVE_FAILURES = 10;

type TypingLoopState = {
  refs: number;
  interval: ReturnType<typeof setInterval>;
  ttl: ReturnType<typeof setTimeout>;
};

/**
 * 401 error detection and backoff state
 */
interface BackoffState {
  consecutiveFailures: number;
  currentBackoffMs: number;
  suspended: boolean;
}

/**
 * Telegram typing manager with 401 error backoff protection
 *
 * Sends typing indicators to Telegram and handles 401 errors gracefully.
 * 401 errors indicate the bot was deleted or blocked, so we need to
 * back off exponentially to avoid getting the bot deleted by Telegram.
 */
export class TypingManager {
  private typingLoops = new Map<string, TypingLoopState>();
  private sendAction: (peerId: string) => Promise<void>;
  private backoffState: BackoffState = {
    consecutiveFailures: 0,
    currentBackoffMs: INITIAL_BACKOFF_MS,
    suspended: false,
  };

  constructor(sendAction: (peerId: string) => Promise<void>) {
    this.sendAction = sendAction;
  }

  async beginTyping(peerId: string, isConnected: boolean): Promise<(() => Promise<void>) | void> {
    // Check if suspended due to too many 401 errors
    if (this.backoffState.suspended) {
      logger.debug({ peerId }, "Typing suspended due to 401 errors");
      return;
    }

    if (!isConnected) {
      return;
    }

    const existing = this.typingLoops.get(peerId);
    if (existing) {
      existing.refs += 1;
      return async () => {
        this.releaseTyping(peerId);
      };
    }

    await this.sendActionWithBackoff(peerId);

    const interval = setInterval(() => {
      void this.sendActionWithBackoff(peerId);
    }, TYPING_INTERVAL_MS);
    const ttl = setTimeout(() => {
      this.clearTypingLoop(peerId);
    }, TYPING_TTL_MS);
    this.typingLoops.set(peerId, {
      refs: 1,
      interval,
      ttl,
    });

    return async () => {
      this.releaseTyping(peerId);
    };
  }

  /**
   * Send typing action with 401 error handling and backoff
   */
  private async sendActionWithBackoff(peerId: string): Promise<void> {
    if (this.backoffState.suspended) {
      return;
    }

    try {
      await this.sendAction(peerId);

      // Success - reset backoff state
      if (this.backoffState.consecutiveFailures > 0) {
        this.backoffState.consecutiveFailures = 0;
        this.backoffState.currentBackoffMs = INITIAL_BACKOFF_MS;
        logger.info("Typing backoff reset after successful action");
      }
    } catch (error) {
      await this.handleSendError(error, peerId);
    }
  }

  /**
   * Handle errors from sendChatAction
   */
  private async handleSendError(error: unknown, peerId: string): Promise<void> {
    const is401Error = this.is401Error(error);

    if (is401Error) {
      this.backoffState.consecutiveFailures++;

      logger.warn(
        {
          peerId,
          consecutiveFailures: this.backoffState.consecutiveFailures,
          currentBackoffMs: this.backoffState.currentBackoffMs,
        },
        "401 error when sending typing indicator",
      );

      if (this.backoffState.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        this.backoffState.suspended = true;
        logger.error(
          { peerId, failures: this.backoffState.consecutiveFailures },
          "Too many 401 errors, suspending typing indicators",
        );
        return;
      }

      // Exponential backoff
      this.backoffState.currentBackoffMs = Math.min(
        this.backoffState.currentBackoffMs * 2,
        MAX_BACKOFF_MS,
      );

      // Wait before retrying
      await this.sleep(this.backoffState.currentBackoffMs);

      // Retry once after backoff
      try {
        await this.sendAction(peerId);
        // If successful, reset
        this.backoffState.consecutiveFailures = 0;
        this.backoffState.currentBackoffMs = INITIAL_BACKOFF_MS;
      } catch (retryError) {
        logger.warn({ error: retryError, peerId }, "Retry failed");
      }
    } else {
      // Non-401 error - just log and continue
      logger.warn({ error, peerId }, "Failed to send typing indicator (non-401)");
    }
  }

  /**
   * Check if error is a Telegram 401 error (not authorized)
   */
  private is401Error(error: unknown): boolean {
    if (!(error instanceof Error)) {
      return false;
    }

    const message = error.message?.toLowerCase() ?? "";

    // Check for common 401 error patterns
    return (
      message.includes("401") ||
      message.includes("unauthorized") ||
      message.includes("not authorized") ||
      message.includes("bot was deleted") ||
      message.includes("user is deactivated") ||
      message.includes("peer_id_invalid") ||
      message.includes("chat not found")
    );
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private releaseTyping(peerId: string): void {
    const entry = this.typingLoops.get(peerId);
    if (!entry) {
      return;
    }
    entry.refs -= 1;
    if (entry.refs <= 0) {
      this.clearTypingLoop(peerId);
    }
  }

  private clearTypingLoop(peerId: string): void {
    const entry = this.typingLoops.get(peerId);
    if (!entry) {
      return;
    }
    clearInterval(entry.interval);
    clearTimeout(entry.ttl);
    this.typingLoops.delete(peerId);
  }

  stopAll(): void {
    for (const peerId of this.typingLoops.keys()) {
      this.clearTypingLoop(peerId);
    }
  }

  /**
   * Reset backoff state after user interaction
   *
   * Call this when the user sends a new message, indicating
   * the bot is still active and can resume typing indicators.
   */
  resetBackoff(): void {
    const wasSuspended = this.backoffState.suspended;
    this.backoffState = {
      consecutiveFailures: 0,
      currentBackoffMs: INITIAL_BACKOFF_MS,
      suspended: false,
    };

    if (wasSuspended) {
      logger.info("Typing backoff reset");
    }
  }

  /**
   * Get current backoff state (for debugging)
   */
  getBackoffState(): { consecutiveFailures: number; suspended: boolean } {
    return {
      consecutiveFailures: this.backoffState.consecutiveFailures,
      suspended: this.backoffState.suspended,
    };
  }
}
