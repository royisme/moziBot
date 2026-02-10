import type { ComponentStatus } from "./types";
import { logger } from "../../logger";

export type HealthChecker = () => Promise<ComponentStatus>;

export class HealthCheck {
  private checkers: Map<string, HealthChecker> = new Map();
  private results: Map<string, ComponentStatus> = new Map();
  private intervalId: ReturnType<typeof setInterval> | null = null;

  register(name: string, checker: HealthChecker): void {
    this.checkers.set(name, checker);
  }

  unregister(name: string): void {
    this.checkers.delete(name);
    this.results.delete(name);
  }

  async check(): Promise<ComponentStatus[]> {
    const results: ComponentStatus[] = [];
    for (const [name, checker] of this.checkers.entries()) {
      try {
        const result = await checker();
        const previous = this.results.get(name);
        this.results.set(name, result);
        results.push(result);

        if (previous && previous.status !== result.status) {
          if (result.status === "healthy") {
            logger.info(`Health check: component ${name} recovered`);
          } else if (result.status === "degraded") {
            logger.warn(`Health check: component ${name} is degraded`);
          } else if (result.status === "unhealthy") {
            logger.error(`Health check: component ${name} is unhealthy`);
          }
        }
      } catch (error) {
        const failedStatus: ComponentStatus = {
          name,
          status: "unhealthy",
          lastCheck: new Date(),
          details: {
            error: error instanceof Error ? error.message : String(error),
          },
        };
        const previous = this.results.get(name);
        this.results.set(name, failedStatus);
        results.push(failedStatus);

        if (!previous || previous.status !== "unhealthy") {
          logger.error(
            `Health check: component ${name} failed with error: ${String(failedStatus.details?.error)}`,
          );
        }
      }
    }
    return results;
  }

  async checkOne(name: string): Promise<ComponentStatus | null> {
    const checker = this.checkers.get(name);
    if (!checker) {
      return null;
    }
    try {
      const result = await checker();
      this.results.set(name, result);
      return result;
    } catch (error) {
      const failedStatus: ComponentStatus = {
        name,
        status: "unhealthy",
        lastCheck: new Date(),
        details: {
          error: error instanceof Error ? error.message : String(error),
        },
      };
      this.results.set(name, failedStatus);
      return failedStatus;
    }
  }

  startLoop(intervalMs: number): void {
    if (this.intervalId) {
      return;
    }
    this.intervalId = setInterval(() => {
      void this.check();
    }, intervalMs);
  }

  stopLoop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  getResults(): ComponentStatus[] {
    return Array.from(this.results.values());
  }

  isHealthy(): boolean {
    const results = this.getResults();
    if (results.length === 0) {
      return true;
    }
    return results.every((r) => r.status === "healthy");
  }

  getOverallStatus(): "healthy" | "degraded" | "unhealthy" {
    const results = this.getResults();
    if (results.length === 0) {
      return "healthy";
    }
    if (results.some((r) => r.status === "unhealthy")) {
      return "unhealthy";
    }
    if (results.some((r) => r.status === "degraded")) {
      return "degraded";
    }
    return "healthy";
  }
}
