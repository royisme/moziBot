/**
 * Persist/load get_updates_buf for WeChat long-poll cursor.
 * Path: <DATA_DIR>/wechat/<token-hash>/get_updates_buf
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { logger } from "../../../../logger";

function tokenHash(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex").slice(0, 8);
}

function getDataDir(): string {
  const pidFile = process.env["MOZI_PID_FILE"];
  if (pidFile && pidFile.trim().length > 0) {
    return path.dirname(path.resolve(pidFile));
  }
  return path.resolve(process.cwd(), "data");
}

function getSyncBufPath(token: string): string {
  const hash = tokenHash(token);
  return path.join(getDataDir(), "wechat", hash, "get_updates_buf");
}

export function loadGetUpdatesBuf(token: string): string {
  const filePath = getSyncBufPath(token);
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const data = JSON.parse(raw) as { get_updates_buf?: string };
    if (typeof data.get_updates_buf === "string") {
      logger.debug({ filePath }, "wechat: loaded get_updates_buf from disk");
      return data.get_updates_buf;
    }
  } catch {
    // file not found or invalid — start fresh
  }
  return "";
}

export function saveGetUpdatesBuf(token: string, buf: string): void {
  const filePath = getSyncBufPath(token);
  try {
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify({ get_updates_buf: buf }), "utf-8");
    logger.debug({ filePath, bufLen: buf.length }, "wechat: saved get_updates_buf");
  } catch (err) {
    logger.warn({ err, filePath }, "wechat: failed to save get_updates_buf");
  }
}
