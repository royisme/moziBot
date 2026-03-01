/**
 * Heartbeat wake mechanism — lets external events (e.g. exec completion)
 * immediately trigger a heartbeat run, with per-session coalesce debouncing.
 */

import { logger } from "../logger";

export type HeartbeatWakeHandler = (opts: {
  reason: string;
  sessionKey?: string;
}) => Promise<"ok" | "skipped">;

const DEFAULT_COALESCE_MS = 500;
const RETRY_DELAY_MS = 1500;
const MAX_RETRIES = 2;

let handler: HeartbeatWakeHandler | null = null;
const timers = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * Register the wake handler (called by HeartbeatRunner.start()).
 * Only one handler at a time; last-write wins.
 */
export function setHeartbeatWakeHandler(h: HeartbeatWakeHandler): void {
  handler = h;
}

/**
 * Request an immediate heartbeat run with coalesce debouncing.
 * If called multiple times within coalesceMs for the same sessionKey,
 * only the last call takes effect.
 */
export function requestHeartbeatNow(opts: {
  reason: string;
  sessionKey?: string;
  coalesceMs?: number;
}): void {
  if (!handler) {
    return; // No handler registered — silently ignore
  }

  const key = opts.sessionKey ?? "__global__";
  const coalesceMs = opts.coalesceMs ?? DEFAULT_COALESCE_MS;

  // Cancel any pending coalesce timer for this session
  const existing = timers.get(key);
  if (existing !== undefined) {
    clearTimeout(existing);
  }

  const timer = setTimeout(() => {
    timers.delete(key);
    void dispatchWake(opts.reason, opts.sessionKey, 0);
  }, coalesceMs);

  timers.set(key, timer);
}

async function dispatchWake(
  reason: string,
  sessionKey: string | undefined,
  retryCount: number,
): Promise<void> {
  if (!handler) {
    return;
  }

  try {
    const result = await handler({ reason, sessionKey });

    if (result === "skipped" && retryCount < MAX_RETRIES) {
      logger.debug({ reason, sessionKey, retryCount }, "Heartbeat wake skipped, scheduling retry");
      setTimeout(() => {
        void dispatchWake(reason, sessionKey, retryCount + 1);
      }, RETRY_DELAY_MS);
    }
  } catch (error) {
    logger.warn({ error, reason, sessionKey }, "Heartbeat wake handler error");
  }
}

/** Clear handler and all timers (for testing). */
export function _resetWake(): void {
  handler = null;
  for (const t of timers.values()) {
    clearTimeout(t);
  }
  timers.clear();
}
