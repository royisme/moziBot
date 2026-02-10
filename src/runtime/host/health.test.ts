import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ComponentStatus } from "./types";
import { HealthCheck } from "./health";

describe("HealthCheck", () => {
  let health: HealthCheck;

  beforeEach(() => {
    health = new HealthCheck();
  });

  afterEach(() => {
    health.stopLoop();
  });

  it("should register and run checkers", async () => {
    const checker = vi.fn().mockResolvedValue({
      name: "test",
      status: "healthy",
      lastCheck: new Date(),
    } as ComponentStatus);

    health.register("test", checker);
    const results = await health.check();

    expect(checker).toHaveBeenCalled();
    expect(results).toHaveLength(1);
    expect(results[0].name).toBe("test");
    expect(results[0].status).toBe("healthy");
  });

  it("should handle checker failures", async () => {
    const checker = vi.fn().mockRejectedValue(new Error("failure"));

    health.register("fail", checker);
    const results = await health.check();

    expect(results[0].status).toBe("unhealthy");
    expect(results[0].details?.error).toBe("failure");
  });

  it("should calculate overall status correctly", async () => {
    health.register("c1", async () => ({
      name: "c1",
      status: "healthy",
      lastCheck: new Date(),
    }));
    health.register("c2", async () => ({
      name: "c2",
      status: "degraded",
      lastCheck: new Date(),
    }));

    await health.check();
    expect(health.getOverallStatus()).toBe("degraded");
    expect(health.isHealthy()).toBe(false);

    health.register("c3", async () => ({
      name: "c3",
      status: "unhealthy",
      lastCheck: new Date(),
    }));

    await health.check();
    expect(health.getOverallStatus()).toBe("unhealthy");
  });

  it("should run health loop", async () => {
    vi.useFakeTimers();
    const checker = vi.fn().mockResolvedValue({
      name: "test",
      status: "healthy",
      lastCheck: new Date(),
    } as ComponentStatus);

    health.register("test", checker);
    health.startLoop(100);

    vi.advanceTimersByTime(250);
    expect(checker).toHaveBeenCalledTimes(2);

    vi.useRealTimers();
  });

  it("should check individual component", async () => {
    const checker = vi.fn().mockResolvedValue({
      name: "test",
      status: "healthy",
      lastCheck: new Date(),
    } as ComponentStatus);

    health.register("test", checker);
    const result = await health.checkOne("test");

    expect(result?.status).toBe("healthy");
    expect(health.getResults()).toHaveLength(1);
  });
});
