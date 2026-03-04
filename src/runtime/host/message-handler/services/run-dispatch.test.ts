import { describe, expect, it, vi } from "vitest";
import { startDetachedRun } from "./run-dispatch";

describe("startDetachedRun", () => {
  it("forwards args and returns run id", async () => {
    const starter = vi.fn(async ({ onTerminal }) => {
      await onTerminal?.({ terminal: "failed", reason: "boom", errorCode: "ACP_TURN_FAILED" });
      return { runId: "run-1" };
    });
    const onTerminal = vi.fn();
    const message = { id: "m-1" } as never;
    const channel = { id: "telegram" } as never;

    const result = await startDetachedRun({
      starter,
      message,
      channel,
      queueItemId: "q-1",
      onTerminal,
    });

    expect(result).toEqual({ runId: "run-1" });
    expect(starter).toHaveBeenCalledTimes(1);
    expect(onTerminal).toHaveBeenCalledWith(
      expect.objectContaining({ terminal: "failed", reason: "boom", errorCode: "ACP_TURN_FAILED" }),
    );
    expect(starter).toHaveBeenCalledWith({
      message,
      channel,
      queueItemId: "q-1",
      onTerminal,
    });
  });
});
