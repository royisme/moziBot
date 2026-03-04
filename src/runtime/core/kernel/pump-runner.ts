import { logger } from "../../../logger";
import { runtimeQueue, type RuntimeQueueItem } from "../../../storage/db";

export type PumpRunnerState = {
  activeSessions: Set<string>;
  pumpScheduled: boolean;
  pumping: boolean;
};

export function schedulePumpRunner(params: {
  isStopped: () => boolean;
  state: PumpRunnerState;
  runPump: () => Promise<void>;
}): void {
  if (params.isStopped() || params.state.pumpScheduled) {
    return;
  }
  params.state.pumpScheduled = true;
  queueMicrotask(() => {
    params.state.pumpScheduled = false;
    void params.runPump().catch((error) => {
      const err = error instanceof Error ? error : new Error(String(error));
      logger.error({ error: err.message }, "Scheduled pump run failed");
    });
  });
}

export async function runPumpLoop(params: {
  isStopped: () => boolean;
  state: PumpRunnerState;
  processOne: (queueItem: RuntimeQueueItem, releaseSession: () => void) => Promise<void>;
  schedulePump: () => void;
}): Promise<void> {
  if (params.isStopped() || params.state.pumping) {
    return;
  }
  params.state.pumping = true;
  try {
    while (!params.isStopped()) {
      const next = pickNextRunnable(params.state.activeSessions);
      if (!next) {
        break;
      }
      const claimed = runtimeQueue.claim(next.id);
      if (!claimed) {
        continue;
      }
      logger.info(
        {
          queueItemId: next.id,
          sessionKey: next.session_key,
          channel: next.channel_id,
          peerId: next.peer_id,
          attempts: next.attempts,
        },
        "Queue item claimed",
      );
      params.state.activeSessions.add(next.session_key);
      let released = false;
      const releaseSession = () => {
        if (released) {
          return;
        }
        released = true;
        if (params.state.activeSessions.delete(next.session_key)) {
          params.schedulePump();
        }
      };
      void params.processOne(next, releaseSession).catch((error) => {
        const err = error instanceof Error ? error : new Error(String(error));
        logger.error(
          {
            queueItemId: next.id,
            sessionKey: next.session_key,
            error: err.message,
          },
          "Queue item processing crashed",
        );
        releaseSession();
      });
    }
  } finally {
    params.state.pumping = false;
  }
}

function pickNextRunnable(activeSessions: Set<string>): RuntimeQueueItem | null {
  const candidates = runtimeQueue.listRunnable(64);
  for (const item of candidates) {
    if (!activeSessions.has(item.session_key)) {
      return item;
    }
  }
  return null;
}
