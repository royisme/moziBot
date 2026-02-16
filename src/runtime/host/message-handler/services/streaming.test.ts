import { beforeEach, describe, expect, it, vi } from "vitest";
import { StreamingBuffer } from "./streaming";

describe("StreamingBuffer", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it("sends first delta directly without placeholder", async () => {
    const send = vi.fn(async () => "m1");
    const editMessage = vi.fn(async () => {});
    const buffer = new StreamingBuffer({ send, editMessage }, "peer-1", undefined, "turn:1");

    buffer.append("hello");
    await Promise.resolve();
    await Promise.resolve();

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith("peer-1", { text: "hello", traceId: "turn:1" });
    expect(editMessage).not.toHaveBeenCalled();
  });

  it("finalize edits existing stream message with final text", async () => {
    const send = vi.fn(async () => "m2");
    const editMessage = vi.fn(async () => {});
    const buffer = new StreamingBuffer({ send, editMessage }, "peer-2");

    buffer.append("part");
    await Promise.resolve();
    await Promise.resolve();

    const id = await buffer.finalize("final answer");

    expect(id).toBe("m2");
    expect(editMessage).toHaveBeenCalledTimes(1);
    expect(editMessage).toHaveBeenLastCalledWith("m2", "peer-2", "final answer");
  });

  it("finalize falls back to send when edit fails", async () => {
    const send = vi
      .fn<(...args: unknown[]) => Promise<string>>()
      .mockResolvedValueOnce("m3")
      .mockResolvedValueOnce("m4");
    const editMessage = vi.fn(async () => {
      throw new Error("edit failed");
    });
    const onError = vi.fn();
    const buffer = new StreamingBuffer({ send, editMessage }, "peer-3", onError);

    buffer.append("draft");
    await Promise.resolve();
    await Promise.resolve();

    const id = await buffer.finalize("final text");

    expect(id).toBe("m4");
    expect(send).toHaveBeenCalledTimes(2);
    expect(editMessage).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("does not emit no-response text when final text is empty", async () => {
    const send = vi.fn(async () => "m5");
    const editMessage = vi.fn(async () => {});
    const buffer = new StreamingBuffer({ send, editMessage }, "peer-4");

    const id = await buffer.finalize(undefined);

    expect(id).toBeNull();
    expect(send).not.toHaveBeenCalled();
    expect(editMessage).not.toHaveBeenCalled();
  });

  it("debounces follow-up edits", async () => {
    vi.useFakeTimers();
    const send = vi.fn(async () => "m6");
    const editMessage = vi.fn(async () => {});
    const buffer = new StreamingBuffer({ send, editMessage }, "peer-5");

    buffer.append("hello");
    vi.runAllTicks();

    buffer.append(" world");
    vi.runAllTicks();
    expect(editMessage).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1000);
    expect(editMessage).toHaveBeenCalledTimes(1);
    expect(editMessage).toHaveBeenCalledWith("m6", "peer-5", "hello world");
  });
});
