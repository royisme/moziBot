/**
 * Long-poll supervisor for WeChat (ilink bot).
 * Calls getUpdates in a loop, normalizes messages, emits them.
 */

import { logger } from "../../../../logger";
import type { InboundMessage } from "../types";
import { getUpdates } from "./api";
import { weixinMessageToInbound } from "./inbound";
import { loadGetUpdatesBuf, saveGetUpdatesBuf } from "./sync-buf";

const SESSION_EXPIRED_ERRCODE = -14;
const SESSION_PAUSE_MS = 30 * 60 * 1_000; // 30 minutes
const MAX_CONSECUTIVE_FAILURES = 3;
const BACKOFF_DELAY_MS = 30_000;
const RETRY_DELAY_MS = 2_000;

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const t = setTimeout(() => {
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(t);
      reject(new Error("aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export interface MonitorOptions {
  channelId: string;
  baseUrl: string;
  token: string;
  allowFrom?: string[];
  /** Long-poll timeout in seconds (not ms). Default: 35 s. */
  longPollTimeoutSeconds?: number;
  abortSignal?: AbortSignal;
  emitMessage: (msg: InboundMessage) => void;
}

export async function runWechatMonitor(opts: MonitorOptions): Promise<void> {
  const { channelId, baseUrl, token, allowFrom, abortSignal, emitMessage } = opts;
  const timeoutMs = (opts.longPollTimeoutSeconds ?? 35) * 1_000;

  let getUpdatesBuf = loadGetUpdatesBuf(token);
  if (getUpdatesBuf) {
    logger.info({ bufLen: getUpdatesBuf.length }, "wechat monitor: resuming from saved buf");
  } else {
    logger.info("wechat monitor: starting fresh (no saved buf)");
  }

  let consecutiveFailures = 0;

  for (;;) {
    if (abortSignal?.aborted) {
      break;
    }
    try {
      const resp = await getUpdates({
        baseUrl,
        token,
        get_updates_buf: getUpdatesBuf,
        timeoutMs,
      });

      const isApiError =
        (resp.ret !== undefined && resp.ret !== 0) ||
        (resp.errcode !== undefined && resp.errcode !== 0);

      if (isApiError) {
        const isSessionExpired =
          resp.errcode === SESSION_EXPIRED_ERRCODE || resp.ret === SESSION_EXPIRED_ERRCODE;

        if (isSessionExpired) {
          logger.error(
            { errcode: resp.errcode },
            `wechat getUpdates: session expired (errcode ${SESSION_EXPIRED_ERRCODE}), resetting cursor and pausing for 30 minutes`,
          );
          // Reset cursor so the next request after the pause starts fresh rather
          // than re-sending the expired buf and triggering another -14 immediately.
          getUpdatesBuf = "";
          saveGetUpdatesBuf(token, "");
          consecutiveFailures = 0;
          await sleep(SESSION_PAUSE_MS, abortSignal);
          continue;
        }

        consecutiveFailures += 1;
        logger.warn(
          { ret: resp.ret, errcode: resp.errcode, errmsg: resp.errmsg, consecutiveFailures },
          "wechat getUpdates: API error",
        );
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          logger.warn(
            { consecutiveFailures },
            "wechat getUpdates: 3 consecutive failures, backing off 30s",
          );
          consecutiveFailures = 0;
          await sleep(BACKOFF_DELAY_MS, abortSignal);
        } else {
          await sleep(RETRY_DELAY_MS, abortSignal);
        }
        continue;
      }

      consecutiveFailures = 0;

      if (resp.get_updates_buf) {
        saveGetUpdatesBuf(token, resp.get_updates_buf);
        getUpdatesBuf = resp.get_updates_buf;
      }

      for (const msg of resp.msgs ?? []) {
        const fromUserId = msg.from_user_id ?? "";

        // allowFrom filtering
        if (allowFrom && allowFrom.length > 0 && !allowFrom.includes(fromUserId)) {
          logger.info({ fromUserId }, "wechat DM dropped by allowFrom");
          continue;
        }

        const inbound = weixinMessageToInbound(msg, channelId);
        if (inbound) {
          emitMessage(inbound);
        }
      }
    } catch (err) {
      if (abortSignal?.aborted) {
        logger.info("wechat monitor: stopped (aborted)");
        return;
      }
      consecutiveFailures += 1;
      logger.warn({ err, consecutiveFailures }, "wechat getUpdates: unexpected error");
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        logger.warn("wechat getUpdates: 3 consecutive failures, backing off 30s");
        consecutiveFailures = 0;
        await sleep(BACKOFF_DELAY_MS, abortSignal);
      } else {
        await sleep(RETRY_DELAY_MS, abortSignal);
      }
    }
  }

  logger.info("wechat monitor: loop ended");
}
