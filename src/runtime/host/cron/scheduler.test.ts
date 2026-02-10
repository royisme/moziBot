import { EventEmitter } from "node:events";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { ChannelPlugin } from "../../adapters/channels/plugin";
import type { CronJob } from "./types";
import { ChannelRegistry } from "../../adapters/channels/registry";
import { CronScheduler } from "./scheduler";

describe("CronScheduler", () => {
  let scheduler: CronScheduler;

  beforeEach(() => {
    scheduler = new CronScheduler();
  });

  afterEach(() => {
    scheduler.stop();
  });

  it("should add and remove jobs", () => {
    const job: CronJob = {
      id: "test-1",
      enabled: true,
      schedule: { kind: "at", atMs: Date.now() + 1000 },
      payload: { kind: "systemEvent", text: "hello" },
      createdAt: new Date(),
    };

    scheduler.add(job);
    expect(scheduler.get("test-1")).toBe(job);
    expect(scheduler.list(true)).toHaveLength(1);

    scheduler.remove("test-1");
    expect(scheduler.get("test-1")).toBeUndefined();
    expect(scheduler.list(true)).toHaveLength(0);
  });

  it("should parse cron expressions correctly", () => {
    const job: CronJob = {
      id: "cron-job",
      enabled: true,
      schedule: { kind: "cron", expr: "0 * * * *" }, // every hour
      payload: { kind: "systemEvent", text: "cron" },
      createdAt: new Date(),
    };

    scheduler.add(job);
    const nextRun = job.nextRunAt;
    expect(nextRun).toBeDefined();
    expect(nextRun!.getMinutes()).toBe(0);
  });

  it("should calculate 'every' interval correctly", () => {
    const now = Date.now();
    const job: CronJob = {
      id: "every-job",
      enabled: true,
      schedule: { kind: "every", everyMs: 1000, anchorMs: now },
      payload: { kind: "systemEvent", text: "every" },
      createdAt: new Date(),
    };

    scheduler.add(job);
    // It should be roughly 1 second from now (or exactly if no time passed)
    // The implementation uses Date.now() inside calculateNextRun, so we check range
    expect(job.nextRunAt!.getTime()).toBeGreaterThanOrEqual(now + 1000);
    expect(job.nextRunAt!.getTime()).toBeLessThanOrEqual(now + 1100);
  });

  it("should handle 'at' one-shot scheduling", async () => {
    const now = Date.now();
    const triggerMs = now + 100;
    const handler = vi.fn(async (_job: CronJob) => {});
    scheduler.setHandler(handler);

    const job: CronJob = {
      id: "at-job",
      enabled: true,
      schedule: { kind: "at", atMs: triggerMs },
      payload: { kind: "systemEvent", text: "at" },
      createdAt: new Date(),
    };

    scheduler.add(job);

    // Wait for it to trigger
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(handler).toHaveBeenCalled();
    expect(job.enabled).toBe(false);
  });

  it("should trigger handler when job runs", async () => {
    const handler = vi.fn(async (_job: CronJob) => {});
    scheduler.setHandler(handler);

    const job: CronJob = {
      id: "trigger-job",
      enabled: true,
      schedule: { kind: "every", everyMs: 50 },
      payload: { kind: "systemEvent", text: "trigger" },
      createdAt: new Date(),
    };

    scheduler.add(job);

    await new Promise((resolve) => setTimeout(resolve, 150));

    // Should have run at least twice (50ms, 100ms)
    expect(handler.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("should handle sendMessage payload", async () => {
    const registry = new ChannelRegistry();
    const mockSend = vi.fn(async (_target: string, _msg: unknown) => "msg-id");

    class MockPlugin extends EventEmitter {
      id = "mock";
      name = "Mock";
      connect = async () => {};
      disconnect = async () => {};
      send = mockSend;
      getStatus = () => "connected" as const;
      isConnected = () => true;
    }

    registry.register(new MockPlugin() as unknown as ChannelPlugin);

    const sendMessageScheduler = new CronScheduler(registry);

    const job: CronJob = {
      id: "send-msg-job",
      enabled: true,
      schedule: { kind: "at", atMs: Date.now() + 50 },
      payload: {
        kind: "sendMessage",
        channel: "mock",
        target: "user1",
        message: "hello from cron",
      },
      createdAt: new Date(),
    };

    sendMessageScheduler.add(job);

    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(mockSend).toHaveBeenCalledWith("user1", { text: "hello from cron" });
    sendMessageScheduler.stop();
  });
});
