import { logger } from "../../../../logger";

const TYPING_INTERVAL_MS = 6_000;
const TYPING_TTL_MS = 2 * 60_000;

type TypingLoopState = {
  refs: number;
  interval: ReturnType<typeof setInterval>;
  ttl: ReturnType<typeof setTimeout>;
};

export class TypingManager {
  private typingLoops = new Map<string, TypingLoopState>();
  private sendAction: (peerId: string) => Promise<void>;

  constructor(sendAction: (peerId: string) => Promise<void>) {
    this.sendAction = sendAction;
  }

  async beginTyping(peerId: string, isConnected: boolean): Promise<(() => Promise<void>) | void> {
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

    await this.sendAction(peerId);

    const interval = setInterval(() => {
      void this.sendAction(peerId);
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
}
