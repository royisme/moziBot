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
    const lastActivityMs = 1_700_000_000_000;

    const handler = {
      getLastRoute: vi.fn(() => ({
        channelId: "telegram",
        peerId: "chat-1",
        peerType: "dm",
        accountId: "acct-1",
        threadId: "topic-7",
      })),
      resolveSessionContext: vi.fn(() => ({
        sessionKey: "agent:mozi:telegram:dm:chat-1",
      })),
      isSessionActive: vi.fn(() => false),
      getSessionTimestamps: vi.fn(() => ({
        createdAt: lastActivityMs - 10_000,
        updatedAt: lastActivityMs,
      })),
    };

    const agentManager = {
      getHomeDir: vi.fn(() => "/tmp/home"),
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
    expect(inbound?.text).toContain("HEARTBEAT_CONTEXT_BEGIN");
    expect(inbound?.text).toContain(`SESSION_LAST_ACTIVITY_MS=${lastActivityMs}`);
    expect(inbound?.text).toContain("HEARTBEAT_CONTEXT_END");
    expect(inbound?.channel).toBe("telegram");
    expect(inbound?.peerId).toBe("chat-1");
    expect(inbound?.peerType).toBe("dm");
    expect(inbound?.accountId).toBe("acct-1");
    expect(inbound?.threadId).toBe("topic-7");

    expect(handler.resolveSessionContext).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "telegram",
        peerId: "chat-1",
        peerType: "dm",
        accountId: "acct-1",
        threadId: "topic-7",
        raw: {
          source: "heartbeat",
          route: {
            channelId: "telegram",
            peerId: "chat-1",
            peerType: "dm",
            accountId: "acct-1",
            threadId: "topic-7",
            replyToId: undefined,
          },
        },
      }),
    );
  });

  it("builds wake session context from remembered canonical route", async () => {
    const enqueueInbound = vi.fn(async (_message: InboundMessage) => {});
    const handler = {
      getLastRoute: vi.fn(() => ({
        channelId: "discord",
        peerId: "thread-3",
        peerType: "group",
        accountId: "acct-9",
        threadId: "th-22",
      })),
      resolveSessionContext: vi.fn(() => ({
        sessionKey: "agent:mozi:discord:group:thread-3",
      })),
      isSessionActive: vi.fn(() => false),
      getSessionTimestamps: vi.fn(() => ({
        createdAt: Date.now(),
      })),
    };

    const agentManager = {
      getHomeDir: vi.fn(() => "/tmp/home"),
    };

    const runner = new HeartbeatRunner(
      handler as never,
      agentManager as never,
      enqueueInbound as never,
    );

    runner.start({
      models: { providers: {} },
      agents: {
        defaults: { heartbeat: { enabled: true, every: "30m" } },
        mozi: { model: "quotio/gemini-3-flash-preview" },
      },
    } as never);

    const wake = runner as unknown as {
      handleWake: (reason: string, sessionKey?: string) => Promise<string>;
    };
    await wake.handleWake("manual", "agent:mozi:discord:group:thread-3");

    expect(handler.resolveSessionContext).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "discord",
        peerId: "thread-3",
        peerType: "group",
        accountId: "acct-9",
        threadId: "th-22",
        raw: {
          source: "heartbeat-wake",
          reason: "manual",
          route: {
            channelId: "discord",
            peerId: "thread-3",
            peerType: "group",
            accountId: "acct-9",
            threadId: "th-22",
            replyToId: undefined,
          },
        },
      }),
    );
  });

  it("schedules only explicit heartbeat agents when any entry defines heartbeat", () => {
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
      getSessionTimestamps: vi.fn(() => ({
        createdAt: Date.now(),
      })),
    };

    const agentManager = {
      getHomeDir: vi.fn(() => "/tmp/home"),
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
          },
        },
        mozi: {
          main: true,
          model: "quotio/gemini-3-flash-preview",
        },
        "dev-coder": {
          heartbeat: { enabled: true, every: "5m" },
        },
      },
    } as never);

    const stateMap = (runner as unknown as { states: Map<string, unknown> }).states;
    expect(stateMap.size).toBe(1);
    expect(stateMap.has("dev-coder")).toBe(true);
  });
});
