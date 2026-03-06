import { describe, expect, it, vi } from "vitest";
import { InMemoryAgentJobRegistry } from "./registry";
import { AgentJobRunner } from "./runner";

function createJob() {
  return {
    id: "job-1",
    sessionKey: "agent:mozi:telegram:dm:user-1",
    agentId: "mozi",
    channelId: "telegram",
    peerId: "user-1",
    source: "reminder" as const,
    kind: "scheduled" as const,
    prompt: "hello",
    traceId: "trace-job-1",
  };
}

describe("AgentJobRunner", () => {
  it("completes_job_and_returns_final_text", async () => {
    const registry = new InMemoryAgentJobRegistry({ now: vi.fn(() => 1_000) });
    const job = registry.create(createJob());
    const runner = new AgentJobRunner({
      registry,
      executePrompt: async ({ onStream }) => {
        await onStream?.({ type: "text_delta", delta: "hello " });
        await onStream?.({ type: "text_delta", delta: "world" });
        await onStream?.({ type: "agent_end", fullText: "hello world" });
      },
      now: vi.fn(() => 1_100),
    });

    const result = await runner.run(job);

    expect(result.finalText).toBe("hello world");
    expect(result.snapshot.status).toBe("completed");
    expect(result.snapshot.resultSummary).toBe("hello world");
    expect(registry.get(job.id)).toBeNull();
  });

  it("records_tool_events", async () => {
    const registry = new InMemoryAgentJobRegistry({ now: vi.fn(() => 1_000) });
    const job = registry.create(createJob());
    const runner = new AgentJobRunner({
      registry,
      executePrompt: async ({ onStream }) => {
        await onStream?.({
          type: "tool_start",
          runId: "run:job-1",
          toolName: "search",
          toolCallId: "tc-1",
        });
        await onStream?.({
          type: "tool_end",
          runId: "run:job-1",
          toolName: "search",
          toolCallId: "tc-1",
        });
      },
      now: vi.fn(() => 1_100),
    });

    await runner.run(job);

    expect(registry.listEvents(job.id).map((event) => event.type)).toEqual([
      "job_queued",
      "job_started",
      "job_tool_start",
      "job_tool_end",
      "job_completed",
    ]);
    expect(
      registry
        .listEvents(job.id)
        .slice(2, 4)
        .map((event) => event.runId),
    ).toEqual(["run:job-1", "run:job-1"]);
  });

  it("marks_failed_snapshot_when_executor_throws", async () => {
    const registry = new InMemoryAgentJobRegistry({ now: vi.fn(() => 1_000) });
    const job = registry.create(createJob());
    const runner = new AgentJobRunner({
      registry,
      executePrompt: async ({ onStream }) => {
        await onStream?.({ type: "text_delta", delta: "partial" });
        throw new Error("boom");
      },
      now: vi.fn(() => 1_100),
    });

    const result = await runner.run(job);

    expect(result.snapshot.status).toBe("failed");
    expect(result.snapshot.error).toBe("boom");
    expect(result.finalText).toBe("partial");
  });

  it("marks_cancelled_when_abort_signal_is_aborted", async () => {
    const registry = new InMemoryAgentJobRegistry({ now: vi.fn(() => 1_000) });
    const job = registry.create(createJob());
    const controller = new AbortController();
    const runner = new AgentJobRunner({
      registry,
      executePrompt: async ({ abortSignal }) => {
        controller.abort(new Error("cancelled"));
        throw abortSignal?.reason ?? new Error("cancelled");
      },
      now: vi.fn(() => 1_100),
    });

    const result = await runner.run(job, controller.signal);

    expect(result.snapshot.status).toBe("cancelled");
  });

  it("delivers_after_completed_run_when_delivery_is_configured", async () => {
    const registry = new InMemoryAgentJobRegistry({ now: vi.fn(() => 1_000) });
    const job = registry.create(createJob());
    const deliver = vi.fn(async () => ({ delivered: true, attempts: 1, outboundId: "out-1" }));
    const runner = new AgentJobRunner({
      registry,
      executePrompt: async ({ onStream }) => {
        await onStream?.({ type: "text_delta", delta: "hello" });
        await onStream?.({ type: "agent_end", fullText: "hello" });
      },
      delivery: { deliver } as unknown as ConstructorParameters<
        typeof AgentJobRunner
      >[0]["delivery"],
      now: vi.fn(() => 1_100),
    });

    await runner.run(job);

    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliver).toHaveBeenCalledWith(
      expect.objectContaining({
        job: expect.objectContaining({ id: "job-1" }),
        snapshot: expect.objectContaining({ status: "completed" }),
        text: "hello",
      }),
    );
  });
});
