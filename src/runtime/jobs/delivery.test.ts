import { describe, expect, it, vi } from "vitest";
import { AgentJobDelivery } from "./delivery";
import { InMemoryAgentJobRegistry } from "./registry";

function createJob() {
  return {
    id: "job-1",
    sessionKey: "agent:mozi:telegram:dm:user-1",
    agentId: "mozi",
    route: {
      channelId: "telegram",
      peerId: "user-1",
      peerType: "dm" as const,
      accountId: "default",
      threadId: "42",
      replyToId: "99",
    },
    source: "reminder" as const,
    kind: "scheduled" as const,
    prompt: "hello",
    traceId: "trace-job-1",
  };
}

describe("AgentJobDelivery", () => {
  it("delivers_completed_job_result", async () => {
    const registry = new InMemoryAgentJobRegistry();
    const job = registry.create(createJob());
    const send = vi.fn(async () => "out-1");
    const delivery = new AgentJobDelivery({
      registry,
      dispatch: { send },
    });

    const result = await delivery.deliver({
      job,
      snapshot: {
        id: job.id,
        status: "completed",
        resultSummary: "done",
        ts: 1_000,
      },
      text: "done",
      runId: "run:job-1",
    });

    expect(result).toEqual({ delivered: true, attempts: 1, outboundId: "out-1" });
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        delivery: {
          route: {
            channelId: "telegram",
            peerId: "user-1",
            peerType: "dm",
            accountId: "default",
            threadId: "42",
            replyToId: "99",
          },
          traceId: "trace-job-1",
          sessionKey: "agent:mozi:telegram:dm:user-1",
          agentId: "mozi",
          source: "job",
        },
        replyText: "done",
      }),
    );
    expect(registry.listEvents(job.id).map((event) => event.type)).toEqual([
      "job_queued",
      "job_delivery_requested",
      "job_delivery_succeeded",
    ]);
    expect(
      registry
        .listEvents(job.id)
        .slice(1)
        .map((event) => event.runId),
    ).toEqual(["run:job-1", "run:job-1"]);
  });

  it("records_failed_delivery_without_throwing", async () => {
    const registry = new InMemoryAgentJobRegistry();
    const job = registry.create(createJob());
    const delivery = new AgentJobDelivery({
      registry,
      dispatch: {
        send: vi.fn(async () => {
          throw new Error("send failed");
        }),
      },
      retries: 1,
    });

    const result = await delivery.deliver({
      job,
      snapshot: {
        id: job.id,
        status: "completed",
        resultSummary: "done",
        ts: 1_000,
      },
      text: "done",
      runId: "run:job-1",
    });

    expect(result).toEqual({ delivered: false, attempts: 2, error: "send failed" });
    expect(registry.listEvents(job.id).map((event) => event.type)).toEqual([
      "job_queued",
      "job_delivery_requested",
      "job_delivery_failed",
    ]);
    expect(
      registry
        .listEvents(job.id)
        .slice(1)
        .map((event) => event.runId),
    ).toEqual(["run:job-1", "run:job-1"]);
  });
});
