import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../logger", () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("../../../storage/db", () => ({
  runtimeQueue: {
    markInterruptedBySession: vi.fn(),
  },
}));

const { cancelSession } = vi.hoisted(() => ({
  cancelSession: vi.fn(),
}));

vi.mock("../continuation", () => ({
  continuationRegistry: {
    cancelSession,
  },
}));

import { runtimeQueue } from "../../../storage/db";
import { handleStopCommand } from "./enqueue-coordinator";

function createInbound() {
  return {
    id: "msg-1",
    channel: "telegram",
    peerId: "peer-1",
  } as const;
}

describe("handleStopCommand", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sends cancellation confirmation with pluralized interrupted count", async () => {
    vi.mocked(runtimeQueue.markInterruptedBySession).mockReturnValue(2 as never);
    const send = vi.fn().mockResolvedValue("out-1");

    await handleStopCommand({
      messageHandler: {},
      sessionKey: "session-1",
      inbound: createInbound() as never,
      channelRegistry: {
        get: vi.fn(() => ({ send })),
      } as never,
      activeSessions: new Set(["session-1"]),
    });

    expect(runtimeQueue.markInterruptedBySession).toHaveBeenCalledWith(
      "session-1",
      "Cancelled by /stop command",
    );
    expect(cancelSession).toHaveBeenCalledWith("session-1");
    expect(send).toHaveBeenCalledWith("peer-1", {
      text: "Stopped. (cancelled 2 queued items)",
    });
  });

  it("sends immediate stop signal confirmation when active run exists but nothing was interrupted", async () => {
    vi.mocked(runtimeQueue.markInterruptedBySession).mockReturnValue(0 as never);
    const send = vi.fn().mockResolvedValue("out-2");

    await handleStopCommand({
      messageHandler: {},
      sessionKey: "session-1",
      inbound: createInbound() as never,
      channelRegistry: {
        get: vi.fn(() => ({ send })),
      } as never,
      activeSessions: new Set(["session-1"]),
    });

    expect(send).toHaveBeenCalledWith("peer-1", {
      text: "Stop signal sent.",
    });
  });

  it("sends no-active-run confirmation when session is not active and nothing was interrupted", async () => {
    vi.mocked(runtimeQueue.markInterruptedBySession).mockReturnValue(0 as never);
    const send = vi.fn().mockResolvedValue("out-3");

    await handleStopCommand({
      messageHandler: {},
      sessionKey: "session-1",
      inbound: createInbound() as never,
      channelRegistry: {
        get: vi.fn(() => ({ send })),
      } as never,
      activeSessions: new Set(["other-session"]),
    });

    expect(send).toHaveBeenCalledWith("peer-1", {
      text: "No active run to stop.",
    });
  });

  it("does not attempt to send confirmation when channelRegistry is omitted", async () => {
    vi.mocked(runtimeQueue.markInterruptedBySession).mockReturnValue(1 as never);
    const interruptSession = vi.fn().mockResolvedValue(true);

    await handleStopCommand({
      messageHandler: { interruptSession },
      sessionKey: "session-1",
      inbound: createInbound() as never,
    });

    expect(interruptSession).toHaveBeenCalledWith("session-1", "Cancelled by /stop command msg-1");
    expect(cancelSession).toHaveBeenCalledWith("session-1");
  });
});
