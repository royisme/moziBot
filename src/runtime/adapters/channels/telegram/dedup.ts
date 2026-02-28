import { logger } from "../../../../logger";
import path from "node:path";
import { readFile, writeFile } from "node:fs/promises";

const DATA_DIR = process.env.DATA_DIR ?? ".data";

export class TelegramUpdateDedup {
  private watermarkFile: string;
  private lastSafeUpdateId = 0;
  private pendingUpdateIds = new Set<number>();
  private highWatermark = 0;

  constructor(botToken: string) {
    // Use last 8 chars of token to make filename unique per bot
    const suffix = botToken.slice(-8).replace(/[^a-zA-Z0-9]/g, "_");
    this.watermarkFile = path.join(DATA_DIR, `tg_watermark_${suffix}.json`);
  }

  async load(): Promise<number> {
    try {
      const raw = await readFile(this.watermarkFile, "utf-8");
      const data = JSON.parse(raw);
      this.lastSafeUpdateId = data.updateId ?? 0;
      logger.info({ updateId: this.lastSafeUpdateId }, "Loaded Telegram update watermark");
    } catch {
      // Fresh start
    }
    return this.lastSafeUpdateId;
  }

  isDuplicate(updateId: number): boolean {
    return updateId <= this.lastSafeUpdateId;
  }

  markPending(updateId: number): void {
    this.pendingUpdateIds.add(updateId);
    if (updateId > this.highWatermark) this.highWatermark = updateId;
  }

  markDone(updateId: number): void {
    this.pendingUpdateIds.delete(updateId);
    this.maybePersist();
  }

  private async maybePersist(): Promise<void> {
    // Safe watermark = highest contiguous block of done updates
    // Simpler: persist highWatermark only when no pending updates below it
    if (this.pendingUpdateIds.size === 0 && this.highWatermark > this.lastSafeUpdateId) {
      this.lastSafeUpdateId = this.highWatermark;
      try {
        await writeFile(this.watermarkFile, JSON.stringify({ updateId: this.lastSafeUpdateId }), "utf-8");
      } catch (err) {
        logger.warn({ err }, "Failed to persist Telegram watermark");
      }
    }
  }
}
