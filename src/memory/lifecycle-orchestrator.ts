import type { ResolvedMemorySyncConfig } from "./backend-config";
import type { MemorySearchManager } from "./types";
import { logger } from "../logger";

export type MemoryLifecycleEvent =
  | { type: "session_start"; sessionKey: string }
  | { type: "flush_completed"; sessionKey: string }
  | { type: "search_requested"; sessionKey: string };

export class MemoryLifecycleOrchestrator {
  private pendingReasons = new Set<string>();
  private pendingForce = false;
  private draining: Promise<void> | null = null;

  constructor(
    private readonly manager: MemorySearchManager,
    private readonly syncConfig: ResolvedMemorySyncConfig,
  ) {}

  async handle(event: MemoryLifecycleEvent): Promise<void> {
    if (event.type === "session_start") {
      if (!this.syncConfig.onSessionStart) {
        return;
      }
      this.requestSync("session-start", false);
      return;
    }

    if (event.type === "search_requested") {
      if (!this.syncConfig.onSearch) {
        return;
      }
      if (!this.manager.status().dirty) {
        return;
      }
      this.requestSync("search", false);
      return;
    }

    if (!this.syncConfig.forceOnFlush) {
      this.manager.markDirty?.();
      return;
    }

    this.manager.markDirty?.();
    this.requestSync("flush", true);
  }

  private requestSync(reason: string, force: boolean): void {
    if (this.draining) {
      if (force) {
        this.pendingReasons.add(reason);
        this.pendingForce = true;
      }
      return;
    }

    this.pendingReasons.add(reason);
    if (force) {
      this.pendingForce = true;
    }

    this.startDrain();
  }

  private startDrain(): void {
    if (this.draining) {
      return;
    }
    this.draining = this.drain()
      .catch((err) => {
        logger.warn({ err }, "Memory lifecycle sync failed");
      })
      .finally(() => {
        this.draining = null;
        if (this.pendingReasons.size > 0 || this.pendingForce) {
          this.startDrain();
        }
      });
  }

  private async drain(): Promise<void> {
    while (this.pendingReasons.size > 0 || this.pendingForce) {
      const reasons = Array.from(this.pendingReasons).toSorted();
      const force = this.pendingForce;
      this.pendingReasons.clear();
      this.pendingForce = false;
      const reason = reasons.join(",");
      await this.manager.sync?.({ reason, force });
    }
  }

  async waitForIdle(): Promise<void> {
    await this.draining;
  }
}
