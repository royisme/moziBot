/**
 * Per-session in-memory system event queue.
 *
 * Events are enqueued by subsystems (e.g. exec completion) and consumed
 * by HeartbeatRunner to build agent prompts.  Pure in-memory, no persistence.
 */

export interface SystemEventEntry {
  text: string;
  ts: number;
  contextKey?: string;
}

const MAX_EVENTS = 20;

const queues = new Map<string, SystemEventEntry[]>();

/**
 * Enqueue a system event for a session.
 * Returns `true` if the event was actually added (not a duplicate contextKey).
 */
export function enqueueSystemEvent(
  text: string,
  opts: { sessionKey: string; contextKey?: string },
): boolean {
  const { sessionKey, contextKey } = opts;

  let queue = queues.get(sessionKey);
  if (!queue) {
    queue = [];
    queues.set(sessionKey, queue);
  }

  // Dedup: reject if the most recent entry has the same contextKey
  if (contextKey && queue.length > 0) {
    const last = queue[queue.length - 1];
    if (last?.contextKey === contextKey) {
      return false;
    }
  }

  const entry: SystemEventEntry = { text, ts: Date.now(), contextKey };
  queue.push(entry);

  // FIFO eviction when over limit
  while (queue.length > MAX_EVENTS) {
    queue.shift();
  }

  return true;
}

/** Peek at pending events without consuming them. */
export function peekSystemEventEntries(sessionKey: string): SystemEventEntry[] {
  return [...(queues.get(sessionKey) ?? [])];
}

/** Drain (read + clear) all pending events for a session. */
export function drainSystemEvents(sessionKey: string): SystemEventEntry[] {
  const queue = queues.get(sessionKey);
  if (!queue || queue.length === 0) {
    return [];
  }
  const events = [...queue];
  queue.length = 0;
  return events;
}

/** Check whether a session has any pending events. */
export function hasSystemEvents(sessionKey: string): boolean {
  const queue = queues.get(sessionKey);
  return queue !== undefined && queue.length > 0;
}

/** Reset all queues (for testing). */
export function _resetAllQueues(): void {
  queues.clear();
}
