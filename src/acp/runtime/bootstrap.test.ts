import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  bootstrapAcpRuntimeBackends,
  isAcpBackendRegistered,
  __testing as bootstrapTesting,
} from "../../acp/runtime/bootstrap";
import {
  getAcpRuntimeBackend,
  registerAcpRuntimeBackend,
  requireAcpRuntimeBackend,
  __testing,
} from "../../acp/runtime/registry";
import type { AcpRuntime } from "../../acp/runtime/types";
import type { MoziConfig } from "../../config";

// Mock logger to suppress output during tests
vi.mock("../../logger", () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

describe("ACP Runtime Registry", () => {
  beforeEach(() => {
    __testing.resetAcpRuntimeBackendsForTests();
  });

  test("registerAcpRuntimeBackend adds backend to registry", () => {
    const mockRuntime = {
      ensureSession: vi.fn(),
    } as unknown as AcpRuntime;

    registerAcpRuntimeBackend({
      id: "test-backend",
      runtime: mockRuntime,
      healthy: () => true,
    });

    const backend = getAcpRuntimeBackend("test-backend");
    expect(backend).not.toBeNull();
    expect(backend?.id).toBe("test-backend");
    expect(backend?.runtime).toBe(mockRuntime);
  });

  test("getAcpRuntimeBackend returns null when no backend registered", () => {
    const backend = getAcpRuntimeBackend();
    expect(backend).toBeNull();
  });

  test("getAcpRuntimeBackend returns first healthy backend when no id specified", () => {
    const mockRuntime1 = {} as AcpRuntime;
    const mockRuntime2 = {} as AcpRuntime;

    registerAcpRuntimeBackend({
      id: "backend-1",
      runtime: mockRuntime1,
      healthy: () => false,
    });

    registerAcpRuntimeBackend({
      id: "backend-2",
      runtime: mockRuntime2,
      healthy: () => true,
    });

    const backend = getAcpRuntimeBackend();
    expect(backend?.id).toBe("backend-2");
  });

  test("requireAcpRuntimeBackend throws when no backend registered", () => {
    expect(() => requireAcpRuntimeBackend()).toThrow("ACP runtime backend is not configured");
  });

  test("requireAcpRuntimeBackend throws when backend is unhealthy", () => {
    const mockRuntime = {} as AcpRuntime;
    registerAcpRuntimeBackend({
      id: "unhealthy-backend",
      runtime: mockRuntime,
      healthy: () => false,
    });

    expect(() => requireAcpRuntimeBackend("unhealthy-backend")).toThrow(/unavailable/i);
  });

  test("backend id is normalized to lowercase", () => {
    const mockRuntime = {} as AcpRuntime;
    registerAcpRuntimeBackend({
      id: "MixedCaseBackend",
      runtime: mockRuntime,
    });

    // Should find by lowercase
    expect(getAcpRuntimeBackend("mixedcasebackend")).not.toBeNull();
  });
});

describe("ACP Bootstrap", () => {
  beforeEach(() => {
    __testing.resetAcpRuntimeBackendsForTests();
    bootstrapTesting.resetAcpBackendRegisteredForTests();
  });

  function createTestConfig(overrides: Partial<MoziConfig["acp"]> = {}): MoziConfig {
    return {
      models: { providers: {} },
      agents: {},
      acp: {
        enabled: true,
        backend: "acpx",
        dispatch: { enabled: true },
        ...overrides,
      },
    } as MoziConfig;
  }

  test("bootstrapAcpRuntimeBackends registers acpx when configured", async () => {
    const config = createTestConfig({ backend: "acpx" });

    await bootstrapAcpRuntimeBackends(config);

    const backend = getAcpRuntimeBackend("acpx");
    expect(backend).not.toBeNull();
    expect(backend?.id).toBe("acpx");
    expect(isAcpBackendRegistered("acpx")).toBe(true);
  });

  test("bootstrapAcpRuntimeBackends skips registration when ACP not enabled", async () => {
    const config = {
      models: { providers: {} },
      agents: {},
      acp: { enabled: false },
    } as unknown as MoziConfig;

    await bootstrapAcpRuntimeBackends(config);

    expect(getAcpRuntimeBackend()).toBeNull();
    expect(isAcpBackendRegistered()).toBe(false);
  });

  test("bootstrapAcpRuntimeBackends skips registration when no backend configured", async () => {
    const config = createTestConfig({ backend: undefined });

    await bootstrapAcpRuntimeBackends(config);

    expect(getAcpRuntimeBackend()).toBeNull();
  });

  test("bootstrapAcpRuntimeBackends registers override backend", async () => {
    const config = createTestConfig({ backend: undefined });

    await bootstrapAcpRuntimeBackends(config, "acpx");

    const backend = getAcpRuntimeBackend("acpx");
    expect(backend).not.toBeNull();
    expect(backend?.id).toBe("acpx");
  });

  test("bootstrapAcpRuntimeBackends skips unknown backend", async () => {
    const config = createTestConfig({ backend: "unknown-backend" });

    await bootstrapAcpRuntimeBackends(config);

    expect(getAcpRuntimeBackend("unknown-backend")).toBeNull();
  });

  test("bootstrapAcpRuntimeBackends prevents duplicate registration", async () => {
    const config = createTestConfig({ backend: "acpx" });

    await bootstrapAcpRuntimeBackends(config);
    await bootstrapAcpRuntimeBackends(config);

    // Should only have one backend registered
    const backends: string[] = [];
    const registry = __testing.getAcpRuntimeRegistryGlobalStateForTests();
    for (const [id] of registry.backendsById) {
      backends.push(id);
    }
    expect(backends).toHaveLength(1);
  });

  test("isAcpBackendRegistered returns correct state", async () => {
    expect(isAcpBackendRegistered()).toBe(false);

    const config = createTestConfig({ backend: "acpx" });
    await bootstrapAcpRuntimeBackends(config);

    expect(isAcpBackendRegistered()).toBe(true);
    expect(isAcpBackendRegistered("acpx")).toBe(true);
    expect(isAcpBackendRegistered("other")).toBe(false);
  });
});

describe("Integration: Bootstrap + Registry Consumer Flow", () => {
  beforeEach(() => {
    __testing.resetAcpRuntimeBackendsForTests();
    bootstrapTesting.resetAcpBackendRegisteredForTests();
  });

  test("backend is available after bootstrap for consumer to resolve", async () => {
    const config = {
      models: { providers: {} },
      agents: {},
      acp: {
        enabled: true,
        backend: "acpx",
        dispatch: { enabled: true },
      },
    } as unknown as MoziConfig;

    // Step 1: Bootstrap the backend
    await bootstrapAcpRuntimeBackends(config);

    // Step 2: Consumer can now resolve the backend
    const backend = requireAcpRuntimeBackend("acpx");
    expect(backend).not.toBeNull();
    expect(backend.id).toBe("acpx");
    expect(backend.runtime).toBeDefined();
  });

  test("session metadata path resolves backend after bootstrap", async () => {
    const config = {
      models: { providers: {} },
      agents: {},
      acp: {
        enabled: true,
        backend: "acpx",
        dispatch: { enabled: true },
      },
    } as unknown as MoziConfig;

    // Bootstrap first
    await bootstrapAcpRuntimeBackends(config);

    // Simulate consumer getting backend from session metadata
    const sessionBackendId = "acpx";
    const backend = getAcpRuntimeBackend(sessionBackendId);

    expect(backend).not.toBeNull();
    expect(backend?.id).toBe("acpx");
  });
});
