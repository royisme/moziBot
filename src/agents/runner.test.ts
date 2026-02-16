import { beforeEach, describe, expect, vi, test } from "vitest";
import type { Session } from "../runtime/host/sessions/types";
import { AgentExecutor, type AgentRuntimeConfig, type ExecutorConfig } from "./runner";

describe("AgentExecutor", () => {
  let executor: AgentExecutor;
  let mockRuntime: {
    create: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
    remove: ReturnType<typeof vi.fn>;
  };

  const config: ExecutorConfig = {
    containerImage: "mozi-agent-base:latest",
    containerBackend: "docker",
    defaultModel: "quotio/gemini-3-flash-preview",
    apiBaseUrl: "https://api.quotio.ai/v1",
    apiKey: "sk-test",
  };

  const session: Session = {
    key: "agent-1:slack:dm:user-1",
    agentId: "agent-1",
    channel: "slack",
    peerId: "user-1",
    peerType: "dm",
    status: "idle",
    createdAt: new Date(),
    lastActiveAt: new Date(),
  };

  const agent: AgentRuntimeConfig = {
    id: "agent-1",
    workspace: "/tmp/mozi/agent-1",
    model: "gpt-3.5-turbo",
  };

  beforeEach(() => {
    executor = new AgentExecutor(config);

    mockRuntime = {
      create: vi.fn(async () => ({
        id: "id",
        name: "name",
        status: "running",
        backend: "docker",
      })),
      stop: vi.fn(async () => {}),
      remove: vi.fn(async () => {}),
    };

    (executor.runtime as unknown as typeof mockRuntime).create = mockRuntime.create as never;
    (executor.runtime as unknown as typeof mockRuntime).stop = mockRuntime.stop as never;
    (executor.runtime as unknown as typeof mockRuntime).remove = mockRuntime.remove as never;
  });

  test("start creates container with correct config", async () => {
    const run = await executor.start(session, agent, "Hello agent");

    expect(run.status).toBe("running");
    expect(run.agentId).toBe(agent.id);
    expect(run.sessionKey).toBe(session.key);
    expect(run.containerName).toMatch(/^mozi-agent-[a-f0-9]{8}$/);

    expect(mockRuntime.create).toHaveBeenCalled();

    const [name, containerConfig] = mockRuntime.create.mock.calls[0] as [
      string,
      {
        image: string;
        env: Record<string, string>;
        mounts: { source: string; target: string; readonly: boolean }[];
      },
    ];

    expect(name).toBe(run.containerName);
    expect(containerConfig.image).toBe(config.containerImage);
    expect(containerConfig.env.MOZI_AGENT_ID).toBe(agent.id);
    expect(containerConfig.env.MOZI_SESSION_KEY).toBe(session.key);
    expect(containerConfig.env.MOZI_MODEL).toBe(agent.model);
    expect(containerConfig.env.MOZI_PROMPT).toBe("Hello agent");
    expect(containerConfig.mounts[0]).toEqual({
      source: agent.workspace,
      target: "/workspace",
      readonly: false,
    });
  });

  test("stop removes container", async () => {
    const run = await executor.start(session, agent, "Hello");
    await executor.stop(run.id);

    const updatedRun = executor.getRun(run.id);
    expect(updatedRun?.status).toBe("completed");
    expect(mockRuntime.stop).toHaveBeenCalledWith(run.containerName);
    expect(mockRuntime.remove).toHaveBeenCalledWith(run.containerName);
  });

  test("run tracking", async () => {
    const run = await executor.start(session, agent, "Hello");
    expect(executor.getRun(run.id)).toBeDefined();
    expect(executor.getRun("non-existent")).toBeUndefined();
  });

  test("listRuns filtering", async () => {
    const run1 = await executor.start(session, agent, "Hello 1");
    const session2 = { ...session, key: "other-session" };
    await executor.start(session2, agent, "Hello 2");

    const allRuns = executor.listRuns();
    expect(allRuns.length).toBe(2);

    const session1Runs = executor.listRuns(session.key);
    expect(session1Runs.length).toBe(1);
    expect(session1Runs[0]?.id).toBe(run1.id);
  });

  test("cleanup removes finished runs", async () => {
    const run = await executor.start(session, agent, "Hello");
    await executor.stop(run.id);

    expect(executor.listRuns().length).toBe(1);
    await executor.cleanup();
    expect(executor.listRuns().length).toBe(0);
  });
});
