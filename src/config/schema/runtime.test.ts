import { describe, expect, it } from "vitest";
import { MoziConfigSchema } from "./index";

describe("Runtime schema", () => {
  it("accepts queue mode config", () => {
    const result = MoziConfigSchema.safeParse({
      runtime: {
        sanitizeToolSchema: true,
        queue: {
          mode: "collect",
          collectWindowMs: 500,
          maxBacklog: 4,
        },
      },
    });
    expect(result.success).toBe(true);
  });

  it("accepts steer-backlog queue mode", () => {
    const result = MoziConfigSchema.safeParse({
      runtime: {
        queue: {
          mode: "steer-backlog",
        },
      },
    });
    expect(result.success).toBe(true);
  });

  it("rejects invalid queue mode", () => {
    const result = MoziConfigSchema.safeParse({
      runtime: {
        queue: {
          mode: "invalid",
        },
      },
    });
    expect(result.success).toBe(false);
  });

  it("rejects negative collect window", () => {
    const result = MoziConfigSchema.safeParse({
      runtime: {
        queue: {
          mode: "collect",
          collectWindowMs: -1,
        },
      },
    });
    expect(result.success).toBe(false);
  });

  it("accepts runtime cron jobs", () => {
    const result = MoziConfigSchema.safeParse({
      runtime: {
        cron: {
          jobs: [
            {
              id: "job-1",
              schedule: { kind: "every", everyMs: 60_000 },
              payload: { kind: "systemEvent", text: "heartbeat" },
            },
            {
              id: "job-2",
              schedule: { kind: "cron", expr: "*/5 * * * *" },
              payload: {
                kind: "sendMessage",
                channel: "telegram",
                target: "1001",
                message: "hello",
              },
              enabled: false,
            },
          ],
        },
      },
    });
    expect(result.success).toBe(true);
  });

  it("accepts legacy top-level cron for compatibility", () => {
    const result = MoziConfigSchema.safeParse({
      cron: {
        jobs: [
          {
            id: "legacy-job",
            schedule: { kind: "at", atMs: Date.now() + 60_000 },
            payload: { kind: "agentTurn", agentId: "mozi", text: "run" },
          },
        ],
      },
    });
    expect(result.success).toBe(true);
  });

  it("accepts runtime auth config", () => {
    const result = MoziConfigSchema.safeParse({
      runtime: {
        auth: {
          enabled: true,
          store: "sqlite",
          masterKeyEnv: "MOZI_MASTER_KEY",
          defaultScope: "agent",
        },
      },
    });
    expect(result.success).toBe(true);
  });

  it("rejects invalid runtime auth scope", () => {
    const result = MoziConfigSchema.safeParse({
      runtime: {
        auth: {
          defaultScope: "session",
        },
      },
    });
    expect(result.success).toBe(false);
  });
});
