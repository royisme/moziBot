import { existsSync, unlinkSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ChannelPlugin } from "../adapters/channels/plugin";
import type { InboundMessage, OutboundMessage } from "../adapters/channels/types";
import { closeDb, initDb, runtimeQueue } from "../../storage/db";
import { RuntimeKernel } from "./kernel";

const TEST_DB = "data/test-runtime-kernel.db";

function cleanupTestDb() {
  if (existsSync(TEST_DB)) {
    unlinkSync(TEST_DB);
  }
  if (existsSync(`${TEST_DB}-wal`)) {
    unlinkSync(`${TEST_DB}-wal`);
  }
  if (existsSync(`${TEST_DB}-shm`)) {
    unlinkSync(`${TEST_DB}-shm`);
  }
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(check: () => boolean, timeoutMs = 2000, pollMs = 20): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (check()) {
      return true;
    }
    await wait(pollMs);
  }
  return false;
}

function buildInbound(id: string, peerId: string): InboundMessage {
  return {
    id,
    channel: "telegram",
    peerId,
    peerType: "dm",
    senderId: `sender-${peerId}`,
    text: `hello-${id}`,
    timestamp: new Date(),
    raw: { source: "test" },
  };
}

type SessionStatus =
  | "idle"
  | "queued"
  | "running"
  | "retrying"
  | "completed"
  | "failed"
  | "interrupted";

class FakeSessionManager {
  private statuses = new Map<string, SessionStatus>();

  async getOrCreate(key: string, defaults: { status?: SessionStatus } = {}) {
    if (!this.statuses.has(key)) {
      this.statuses.set(key, defaults.status || "idle");
    }
    return { key };
  }

  async setStatus(key: string, status: SessionStatus) {
    this.statuses.set(key, status);
  }

  getStatus(key: string): SessionStatus | undefined {
    return this.statuses.get(key);
  }
}

describe("RuntimeKernel", () => {
  beforeEach(() => {
    cleanupTestDb();
    initDb(TEST_DB);
  });

  afterEach(() => {
    closeDb();
    cleanupTestDb();
  });

  it("serializes same-session inbound messages in one lane", async () => {
    const sessionManager = new FakeSessionManager();
    let inFlight = 0;
    let maxInFlight = 0;
    const handled: string[] = [];

    const handler = {
      resolveSessionContext: (message: InboundMessage) => ({
        agentId: "mozi",
        sessionKey: `agent:mozi:telegram:dm:${message.peerId}`,
      }),
      handle: async (message: InboundMessage, channel: ChannelPlugin) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await wait(30);
        await channel.send(message.peerId, { text: `ok-${message.id}` } as OutboundMessage);
        handled.push(message.id);
        inFlight -= 1;
      },
    };

    const channel = {
      send: async () => "out-1",
    } as unknown as ChannelPlugin;
    const channelRegistry = {
      get: () => channel,
    };

    const kernel = new RuntimeKernel({
      messageHandler: handler as never,
      sessionManager: sessionManager as never,
      channelRegistry: channelRegistry as never,
      queueConfig: {
        mode: "followup",
      },
      pollIntervalMs: 10,
    });
    await kernel.start();

    await kernel.enqueueInbound({
      id: "e1",
      inbound: buildInbound("m1", "peer-1"),
      receivedAt: new Date(),
    });
    await kernel.enqueueInbound({
      id: "e2",
      inbound: buildInbound("m2", "peer-1"),
      receivedAt: new Date(),
    });

    const ok = await waitFor(() => handled.length === 2);
    await kernel.stop();

    expect(ok).toBe(true);
    expect(maxInFlight).toBe(1);
    expect(handled).toEqual(["m1", "m2"]);
    expect(sessionManager.getStatus("agent:mozi:telegram:dm:peer-1")).toBe("completed");
  });

  it("runs different sessions in parallel", async () => {
    const sessionManager = new FakeSessionManager();
    let inFlight = 0;
    let maxInFlight = 0;
    const handled = new Set<string>();

    const handler = {
      resolveSessionContext: (message: InboundMessage) => ({
        agentId: "mozi",
        sessionKey: `agent:mozi:telegram:dm:${message.peerId}`,
      }),
      handle: async (message: InboundMessage, channel: ChannelPlugin) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await wait(40);
        await channel.send(message.peerId, { text: `ok-${message.id}` } as OutboundMessage);
        handled.add(message.id);
        inFlight -= 1;
      },
    };

    const channel = {
      send: async () => "out-2",
    } as unknown as ChannelPlugin;
    const channelRegistry = {
      get: () => channel,
    };

    const kernel = new RuntimeKernel({
      messageHandler: handler as never,
      sessionManager: sessionManager as never,
      channelRegistry: channelRegistry as never,
      queueConfig: {
        mode: "followup",
      },
      pollIntervalMs: 10,
    });
    await kernel.start();

    await kernel.enqueueInbound({
      id: "e3",
      inbound: buildInbound("m3", "peer-a"),
      receivedAt: new Date(),
    });
    await kernel.enqueueInbound({
      id: "e4",
      inbound: buildInbound("m4", "peer-b"),
      receivedAt: new Date(),
    });

    const ok = await waitFor(() => handled.size === 2);
    await kernel.stop();

    expect(ok).toBe(true);
    expect(maxInFlight).toBe(2);
  });

  it("deduplicates inbound envelopes by dedup key", async () => {
    const sessionManager = new FakeSessionManager();
    const handler = {
      resolveSessionContext: (message: InboundMessage) => ({
        agentId: "mozi",
        sessionKey: `agent:mozi:telegram:dm:${message.peerId}`,
      }),
      handle: async (_message: InboundMessage, _channel: ChannelPlugin) => {},
    };
    const channelRegistry = {
      get: () =>
        ({
          send: async () => "out-3",
        }) as unknown as ChannelPlugin,
    };
    const kernel = new RuntimeKernel({
      messageHandler: handler as never,
      sessionManager: sessionManager as never,
      channelRegistry: channelRegistry as never,
      queueConfig: {
        mode: "followup",
      },
      pollIntervalMs: 10,
    });
    await kernel.start();

    const msg = buildInbound("same-id", "peer-dedup");
    const first = await kernel.enqueueInbound({
      id: "same-envelope",
      inbound: msg,
      dedupKey: "telegram:same-id",
      receivedAt: new Date(),
    });
    const second = await kernel.enqueueInbound({
      id: "same-envelope-2",
      inbound: msg,
      dedupKey: "telegram:same-id",
      receivedAt: new Date(),
    });
    await kernel.stop();

    expect(first.accepted).toBe(true);
    expect(second.accepted).toBe(false);
    expect(second.deduplicated).toBe(true);
  });

  it("marks running records as interrupted on startup and replays queued records", async () => {
    const now = new Date().toISOString();
    runtimeQueue.enqueue({
      id: "running-1",
      dedupKey: "telegram:running-1",
      sessionKey: "agent:mozi:telegram:dm:peer-run",
      channelId: "telegram",
      peerId: "peer-run",
      peerType: "dm",
      inboundJson: JSON.stringify(buildInbound("running-msg", "peer-run")),
      enqueuedAt: now,
      availableAt: now,
    });
    runtimeQueue.claim("running-1");

    runtimeQueue.enqueue({
      id: "queued-1",
      dedupKey: "telegram:queued-1",
      sessionKey: "agent:mozi:telegram:dm:peer-queued",
      channelId: "telegram",
      peerId: "peer-queued",
      peerType: "dm",
      inboundJson: JSON.stringify(buildInbound("queued-msg", "peer-queued")),
      enqueuedAt: now,
      availableAt: now,
    });

    const sessionManager = new FakeSessionManager();
    const handled: string[] = [];
    const handler = {
      resolveSessionContext: (message: InboundMessage) => ({
        agentId: "mozi",
        sessionKey: `agent:mozi:telegram:dm:${message.peerId}`,
      }),
      handle: async (message: InboundMessage, _channel: ChannelPlugin) => {
        handled.push(message.id);
      },
    };
    const channelRegistry = {
      get: () =>
        ({
          send: async () => "out-4",
        }) as unknown as ChannelPlugin,
    };
    const kernel = new RuntimeKernel({
      messageHandler: handler as never,
      sessionManager: sessionManager as never,
      channelRegistry: channelRegistry as never,
      queueConfig: {
        mode: "followup",
      },
      pollIntervalMs: 10,
    });

    await kernel.start();
    const ok = await waitFor(() => handled.includes("queued-msg"));
    await kernel.stop();

    const interrupted = runtimeQueue.getById("running-1");
    const queued = runtimeQueue.getById("queued-1");
    expect(ok).toBe(true);
    expect(interrupted?.status).toBe("interrupted");
    expect(queued?.status).toBe("completed");
  });

  it("collect mode merges burst messages into one queued envelope", async () => {
    const sessionManager = new FakeSessionManager();
    const handled: Array<{ id: string; text: string }> = [];
    const handler = {
      resolveSessionContext: (message: InboundMessage) => ({
        agentId: "mozi",
        sessionKey: `agent:mozi:telegram:dm:${message.peerId}`,
      }),
      handle: async (message: InboundMessage, _channel: ChannelPlugin) => {
        handled.push({ id: message.id, text: message.text });
      },
    };
    const channelRegistry = {
      get: () =>
        ({
          send: async () => "out-collect",
        }) as unknown as ChannelPlugin,
    };
    const kernel = new RuntimeKernel({
      messageHandler: handler as never,
      sessionManager: sessionManager as never,
      channelRegistry: channelRegistry as never,
      queueConfig: {
        mode: "collect",
        collectWindowMs: 120,
      },
      pollIntervalMs: 10,
    });
    await kernel.start();

    await kernel.enqueueInbound({
      id: "collect-e1",
      inbound: buildInbound("collect-m1", "peer-collect"),
      receivedAt: new Date(),
    });
    await wait(30);
    await kernel.enqueueInbound({
      id: "collect-e2",
      inbound: buildInbound("collect-m2", "peer-collect"),
      receivedAt: new Date(),
    });

    const ok = await waitFor(() => handled.length === 1, 3000, 20);
    await kernel.stop();

    expect(ok).toBe(true);
    expect(handled[0]?.id).toBe("collect-m2");
    expect(handled[0]?.text).toContain("hello-collect-m1");
    expect(handled[0]?.text).toContain("hello-collect-m2");
  });

  it("interrupt mode marks active run interrupted and handles latest message next", async () => {
    const sessionManager = new FakeSessionManager();
    const handled: string[] = [];
    const interruptCalls: string[] = [];
    const handler = {
      resolveSessionContext: (message: InboundMessage) => ({
        agentId: "mozi",
        sessionKey: `agent:mozi:telegram:dm:${message.peerId}`,
      }),
      interruptSession: async (sessionKey: string) => {
        interruptCalls.push(sessionKey);
        return true;
      },
      handle: async (message: InboundMessage, _channel: ChannelPlugin) => {
        handled.push(message.id);
        if (message.id === "interrupt-m1") {
          await wait(120);
        }
      },
    };
    const channelRegistry = {
      get: () =>
        ({
          send: async () => "out-interrupt",
        }) as unknown as ChannelPlugin,
    };
    const kernel = new RuntimeKernel({
      messageHandler: handler as never,
      sessionManager: sessionManager as never,
      channelRegistry: channelRegistry as never,
      queueConfig: {
        mode: "interrupt",
      },
      pollIntervalMs: 10,
    });
    await kernel.start();

    await kernel.enqueueInbound({
      id: "interrupt-e1",
      inbound: buildInbound("interrupt-m1", "peer-interrupt"),
      receivedAt: new Date(),
    });

    const running = await waitFor(
      () => runtimeQueue.getById("interrupt-e1")?.status === "running",
      2000,
      20,
    );
    expect(running).toBe(true);

    await kernel.enqueueInbound({
      id: "interrupt-e2",
      inbound: buildInbound("interrupt-m2", "peer-interrupt"),
      receivedAt: new Date(),
    });

    const ok = await waitFor(
      () => runtimeQueue.getById("interrupt-e2")?.status === "completed",
      3000,
      20,
    );
    await kernel.stop();

    expect(ok).toBe(true);
    expect(runtimeQueue.getById("interrupt-e1")?.status).toBe("interrupted");
    expect(handled).toContain("interrupt-m2");
    expect(interruptCalls).toContain("agent:mozi:telegram:dm:peer-interrupt");
  });

  it("steer mode injects message into active run instead of enqueueing", async () => {
    const sessionManager = new FakeSessionManager();
    const injected: Array<{ sessionKey: string; text: string; mode: "steer" | "followup" }> = [];
    const handler = {
      resolveSessionContext: (message: InboundMessage) => ({
        agentId: "mozi",
        sessionKey: `agent:mozi:telegram:dm:${message.peerId}`,
      }),
      steerSession: async (sessionKey: string, text: string, mode: "steer" | "followup") => {
        injected.push({ sessionKey, text, mode });
        return true;
      },
      handle: async () => {
        throw new Error("handle should not be called when steer injection succeeds");
      },
    };
    const channelRegistry = {
      get: () =>
        ({
          send: async () => "out-steer",
        }) as unknown as ChannelPlugin,
    };
    const kernel = new RuntimeKernel({
      messageHandler: handler as never,
      sessionManager: sessionManager as never,
      channelRegistry: channelRegistry as never,
      queueConfig: {
        mode: "steer",
      },
      pollIntervalMs: 10,
    });
    await kernel.start();

    const result = await kernel.enqueueInbound({
      id: "steer-e1",
      inbound: buildInbound("steer-m1", "peer-steer"),
      receivedAt: new Date(),
    });
    await kernel.stop();

    expect(result.accepted).toBe(true);
    expect(runtimeQueue.getById("steer-e1")).toBeNull();
    expect(injected).toEqual([
      {
        sessionKey: "agent:mozi:telegram:dm:peer-steer",
        text: "hello-steer-m1",
        mode: "steer",
      },
    ]);
    expect(sessionManager.getStatus("agent:mozi:telegram:dm:peer-steer")).toBe("running");
  });

  it("steer-backlog mode preempts active run and queues latest message", async () => {
    const sessionManager = new FakeSessionManager();
    const handled: string[] = [];
    const interruptCalls: Array<{ sessionKey: string; reason?: string }> = [];
    const handler = {
      resolveSessionContext: (message: InboundMessage) => ({
        agentId: "mozi",
        sessionKey: `agent:mozi:telegram:dm:${message.peerId}`,
      }),
      isSessionActive: () => true,
      steerSession: async () => {
        return false;
      },
      interruptSession: async (sessionKey: string, reason?: string) => {
        interruptCalls.push({ sessionKey, reason });
        return true;
      },
      handle: async (message: InboundMessage) => {
        handled.push(message.id);
      },
    };
    const channelRegistry = {
      get: () =>
        ({
          send: async () => "out-steer-backlog",
        }) as unknown as ChannelPlugin,
    };
    const kernel = new RuntimeKernel({
      messageHandler: handler as never,
      sessionManager: sessionManager as never,
      channelRegistry: channelRegistry as never,
      queueConfig: {
        mode: "steer-backlog",
      },
      pollIntervalMs: 10,
    });
    await kernel.start();

    const result = await kernel.enqueueInbound({
      id: "steer-backlog-e1",
      inbound: buildInbound("steer-backlog-m1", "peer-steer-backlog"),
      receivedAt: new Date(),
    });
    const ok = await waitFor(() => handled.includes("steer-backlog-m1"), 2000, 20);
    await kernel.stop();

    expect(result.accepted).toBe(true);
    expect(ok).toBe(true);
    expect(interruptCalls).toHaveLength(1);
    expect(interruptCalls[0]?.sessionKey).toBe("agent:mozi:telegram:dm:peer-steer-backlog");
    expect(runtimeQueue.getById("steer-backlog-e1")?.status).toBe("completed");
  });

  it("steer mode falls back to queue for slash commands", async () => {
    const sessionManager = new FakeSessionManager();
    const handled: string[] = [];
    const handler = {
      resolveSessionContext: (message: InboundMessage) => ({
        agentId: "mozi",
        sessionKey: `agent:mozi:telegram:dm:${message.peerId}`,
      }),
      steerSession: async () => true,
      handle: async (message: InboundMessage) => {
        handled.push(message.id);
      },
    };
    const channelRegistry = {
      get: () =>
        ({
          send: async () => "out-steer-cmd",
        }) as unknown as ChannelPlugin,
    };
    const kernel = new RuntimeKernel({
      messageHandler: handler as never,
      sessionManager: sessionManager as never,
      channelRegistry: channelRegistry as never,
      queueConfig: {
        mode: "steer",
      },
      pollIntervalMs: 10,
    });
    await kernel.start();

    const inbound = buildInbound("steer-cmd-m1", "peer-steer-cmd");
    inbound.text = "/status";
    const result = await kernel.enqueueInbound({
      id: "steer-cmd-e1",
      inbound,
      receivedAt: new Date(),
    });

    const ok = await waitFor(() => handled.includes("steer-cmd-m1"), 2000, 20);
    await kernel.stop();

    expect(result.accepted).toBe(true);
    expect(ok).toBe(true);
    expect(runtimeQueue.getById("steer-cmd-e1")?.status).toBe("completed");
  });

  it("steer-backlog mode interrupts active run on /stop before queue processing", async () => {
    const sessionManager = new FakeSessionManager();
    const handled: string[] = [];
    const interruptCalls: Array<{ sessionKey: string; reason?: string }> = [];
    const handler = {
      resolveSessionContext: (message: InboundMessage) => ({
        agentId: "mozi",
        sessionKey: `agent:mozi:telegram:dm:${message.peerId}`,
      }),
      steerSession: async () => true,
      interruptSession: async (sessionKey: string, reason?: string) => {
        interruptCalls.push({ sessionKey, reason });
        return true;
      },
      handle: async (message: InboundMessage) => {
        handled.push(message.id);
      },
    };
    const channelRegistry = {
      get: () =>
        ({
          send: async () => "out-stop-cmd",
        }) as unknown as ChannelPlugin,
    };
    const kernel = new RuntimeKernel({
      messageHandler: handler as never,
      sessionManager: sessionManager as never,
      channelRegistry: channelRegistry as never,
      queueConfig: {
        mode: "steer-backlog",
      },
      pollIntervalMs: 10,
    });
    await kernel.start();

    const inbound = buildInbound("stop-cmd-m1", "peer-stop-cmd");
    inbound.text = "/stop";
    const result = await kernel.enqueueInbound({
      id: "stop-cmd-e1",
      inbound,
      receivedAt: new Date(),
    });

    const ok = await waitFor(() => handled.includes("stop-cmd-m1"), 2000, 20);
    await kernel.stop();

    expect(result.accepted).toBe(true);
    expect(ok).toBe(true);
    expect(interruptCalls).toHaveLength(1);
    expect(interruptCalls[0]?.sessionKey).toBe("agent:mozi:telegram:dm:peer-stop-cmd");
    expect(runtimeQueue.getById("stop-cmd-e1")?.status).toBe("completed");
  });

  it("cancels queued continuation items on /stop command", async () => {
    const sessionKey = "agent:mozi:telegram:dm:peer-stop-continuation";
    const now = new Date().toISOString();
    runtimeQueue.enqueue({
      id: "queued-cont-1",
      dedupKey: "continuation:queued-cont-1",
      sessionKey,
      channelId: "telegram",
      peerId: "peer-stop-continuation",
      peerType: "dm",
      inboundJson: JSON.stringify({
        ...buildInbound("cont-1", "peer-stop-continuation"),
        raw: { source: "continuation" },
      }),
      enqueuedAt: now,
      availableAt: now,
    });

    const sessionManager = new FakeSessionManager();
    const handler = {
      resolveSessionContext: (message: InboundMessage) => ({
        agentId: "mozi",
        sessionKey: `agent:mozi:telegram:dm:${message.peerId}`,
      }),
      handle: async (_message: InboundMessage) => {},
    };
    const channelRegistry = {
      get: () =>
        ({
          send: async () => "out-cancel-intent",
        }) as unknown as ChannelPlugin,
    };
    const kernel = new RuntimeKernel({
      messageHandler: handler as never,
      sessionManager: sessionManager as never,
      channelRegistry: channelRegistry as never,
      queueConfig: {
        mode: "steer-backlog",
      },
      pollIntervalMs: 10,
    });
    await kernel.start();

    const inbound = buildInbound("stop-cmd-m2", "peer-stop-continuation");
    inbound.text = "/stop";
    const result = await kernel.enqueueInbound({
      id: "stop-cmd-e2",
      inbound,
      receivedAt: new Date(),
    });

    await wait(30);
    await kernel.stop();

    expect(result.accepted).toBe(true);
    expect(runtimeQueue.getById("queued-cont-1")?.status).toBe("interrupted");
  });
});
