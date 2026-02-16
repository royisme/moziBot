import { describe, expect, it, vi } from "vitest";
import type { InboundMessage } from "../adapters/channels/types";
import { HeartbeatRunner } from "./heartbeat";

const fsReadFileMock = vi.fn<(...args: unknown[]) => Promise<string>>(async () => "");

vi.mock("node:fs/promises", () => ({
  default: {
    readFile: (...args: unknown[]) => fsReadFileMock(...args),
  },
  readFile: (...args: unknown[]) => fsReadFileMock(...args),
}));

describe("HeartbeatRunner", () => {
  it("injects HEARTBEAT.md content envelope into heartbeat prompt", async () => {
    fsReadFileMock.mockResolvedValueOnce("# HEARTBEAT.md\n@heartbeat enabled=on\n- check inbox");

    const enqueueInbound = vi.fn(async (_message: InboundMessage) => {});

    const handler = {
      getLastRoute: vi.fn(() => ({
        channelId: "telegram",
        peerId: "chat-1",
        peerType: "dm",
      })),
      resolveSessionContext: vi.fn(() => ({
        sessionKey: "agent:mozi:telegram:dm:chat-1",
      })),
      isSessionActive: vi.fn(() => false),
    };

    const agentManager = {
      getWorkspaceDir: vi.fn(() => "/tmp/workspace"),
    };

    const runner = new HeartbeatRunner(
      handler as never,
      agentManager as never,
      enqueueInbound as never,
    );

    runner.updateConfig({
      models: { providers: {} },
      agents: {
        defaults: {
          heartbeat: {
            enabled: true,
            every: "30m",
            prompt: "Read HEARTBEAT.md if it exists",
          },
        },
        mozi: {
          model: "quotio/gemini-3-flash-preview",
        },
      },
    } as never);

    const stateMap = (runner as unknown as { states: Map<string, { nextRunAt: number }> }).states;
    const moziState = stateMap.get("mozi");
    if (moziState) {
      moziState.nextRunAt = Date.now() - 1;
    }

    await (runner as unknown as { tick: () => Promise<void> }).tick();

    expect(enqueueInbound).toHaveBeenCalledTimes(1);
    const inbound = enqueueInbound.mock.calls[0]?.[0];
    expect(inbound?.text).toContain("HEARTBEAT_FILE_BEGIN");
    expect(inbound?.text).toContain("# HEARTBEAT.md");
    expect(inbound?.text).toContain("HEARTBEAT_FILE_END");
  });
});
