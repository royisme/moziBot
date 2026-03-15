import type { EventEnqueuer } from "./contracts.js";

/**
 * Stable indirection layer for EventEnqueuer.
 * RuntimeHost holds one ref; setTarget() is called on each kernel recreation.
 */
export class EventEnqueuerRef implements EventEnqueuer {
  private target: EventEnqueuer;

  constructor(initial: EventEnqueuer) {
    this.target = initial;
  }

  setTarget(next: EventEnqueuer): void {
    this.target = next;
  }

  enqueueEvent(params: Parameters<EventEnqueuer["enqueueEvent"]>[0]): Promise<void> {
    return this.target.enqueueEvent(params);
  }
}
