import type { ResolvedBuiltinMemoryConfig } from "./backend-config";
import type { MemorySearchManager } from "./types";

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
    private readonly builtin: ResolvedBuiltinMemoryConfig,
  ) {}

  async handle(event: MemoryLifecycleEvent): Promise<void> {
    if (event.type === "session_start") {
      if (!this.builtin.sync.onSessionStart) {
        return;
      }
      await this.requestSync("session-start", false);
      return;
    }

    if (event.type === "search_requested") {
      if (!this.builtin.sync.onSearch) {
        return;
      }
      if (!this.manager.status().dirty) {
        return;
      }
      await this.requestSync("search", false);
      return;
    }

    if (!this.builtin.sync.forceOnFlush) {
      this.manager.markDirty?.();
      return;
    }

    this.manager.markDirty?.();
    await this.requestSync("flush", true);
  }

  private async requestSync(reason: string, force: boolean): Promise<void> {
    if (this.draining) {
      if (force) {
        this.pendingReasons.add(reason);
        this.pendingForce = true;
      }
      await this.draining;
      return;
    }

    this.pendingReasons.add(reason);
    if (force) {
      this.pendingForce = true;
    }

    this.draining = this.drain().finally(() => {
      this.draining = null;
    });
    await this.draining;
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
}
