import { describe, expect, it } from "vitest";
import {
  formatTelegramError,
  isGetUpdatesConflict,
  isRecoverableTelegramNetworkError,
} from "./network-errors";

describe("telegram network errors", () => {
  it("treats ENOTFOUND as recoverable", () => {
    const err = new Error("request failed");
    (err as Error & { code?: string }).code = "ENOTFOUND";
    expect(isRecoverableTelegramNetworkError(err, { context: "polling" })).toBe(true);
  });

  it("detects getUpdates conflict", () => {
    const err = {
      error_code: 409,
      description: "Conflict: terminated by other getUpdates request",
    };
    expect(isGetUpdatesConflict(err)).toBe(true);
  });

  it("does not classify invalid token as recoverable network error", () => {
    const err = {
      error_code: 401,
      description: "Unauthorized",
    };
    expect(isRecoverableTelegramNetworkError(err)).toBe(false);
  });

  it("redacts bot token in formatted error", () => {
    const msg =
      "request to https://api.telegram.org/bot8514740032:AAENJv2hp7xLCKcKyz7eFjV1VA3CxgIFcpA/getUpdates failed";
    const text = formatTelegramError(msg);
    expect(text).toContain("bot<redacted>");
    expect(text).not.toContain("AAENJv2hp7xLCKcKyz7eFjV1VA3CxgIFcpA");
  });
});
