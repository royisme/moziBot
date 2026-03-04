import { describe, expect, it, beforeEach, vi } from "vitest";
import { isAcpSessionKey, resolveSessionKey } from "./session-key-utils";

// Mock the session-meta module
vi.mock("./runtime/session-meta", () => ({
  listAcpSessionEntries: vi.fn(),
}));

import { listAcpSessionEntries } from "./runtime/session-meta";

describe("isAcpSessionKey", () => {
  it("should return true for ACP session keys with :acp: segment", () => {
    expect(isAcpSessionKey("agent:main:acp:test-session")).toBe(true);
    expect(isAcpSessionKey("agent:dev:acp:session123")).toBe(true);
  });

  it("should be case-insensitive", () => {
    expect(isAcpSessionKey("agent:main:ACP:test-session")).toBe(true);
    expect(isAcpSessionKey("agent:main:Acp:test-session")).toBe(true);
  });

  it("should return false for non-ACP session keys", () => {
    expect(isAcpSessionKey("agent:main:dm:user123")).toBe(false);
    expect(isAcpSessionKey("general:support:channel")).toBe(false);
  });

  it("should return false for empty or null input", () => {
    expect(isAcpSessionKey("")).toBe(false);
    expect(isAcpSessionKey(null)).toBe(false);
    expect(isAcpSessionKey(undefined)).toBe(false);
  });

  it("should handle whitespace trimming", () => {
    expect(isAcpSessionKey("  agent:main:acp:test  ")).toBe(true);
  });
});

describe("resolveSessionKey", () => {
  const mockListSessions = listAcpSessionEntries as ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockListSessions.mockReturnValue([]);
  });

  it("should return key directly if it contains colon", async () => {
    const result = await resolveSessionKey({ keyOrLabel: "agent:main:acp:test" });
    expect(result).toBe("agent:main:acp:test");
  });

  it("should find exact match by label", async () => {
    mockListSessions.mockReturnValue([
      {
        sessionKey: "agent:main:acp:session1",
        acp: { runtimeSessionName: "my-session" },
      },
    ]);

    const result = await resolveSessionKey({ keyOrLabel: "my-session" });
    expect(result).toBe("agent:main:acp:session1");
  });

  it("should find case-insensitive exact match", async () => {
    mockListSessions.mockReturnValue([
      {
        sessionKey: "agent:main:acp:session1",
        acp: { runtimeSessionName: "My-Session" },
      },
    ]);

    const result = await resolveSessionKey({ keyOrLabel: "my-session" });
    expect(result).toBe("agent:main:acp:session1");
  });

  it("should find partial match when no exact match", async () => {
    mockListSessions.mockReturnValue([
      {
        sessionKey: "agent:main:acp:session1",
        acp: { runtimeSessionName: "production-session-alpha" },
      },
    ]);

    const result = await resolveSessionKey({ keyOrLabel: "alpha" });
    expect(result).toBe("agent:main:acp:session1");
  });

  it("should prefer exact match over partial match", async () => {
    mockListSessions.mockReturnValue([
      {
        sessionKey: "agent:main:acp:exact",
        acp: { runtimeSessionName: "test" },
      },
      {
        sessionKey: "agent:main:acp:partial",
        acp: { runtimeSessionName: "testing" },
      },
    ]);

    const result = await resolveSessionKey({ keyOrLabel: "test" });
    expect(result).toBe("agent:main:acp:exact");
  });

  it("should return null when no match found", async () => {
    mockListSessions.mockReturnValue([
      {
        sessionKey: "agent:main:acp:session1",
        acp: { runtimeSessionName: "other" },
      },
    ]);

    const result = await resolveSessionKey({ keyOrLabel: "nonexistent" });
    expect(result).toBeNull();
  });

  it("should skip sessions without runtimeSessionName", async () => {
    mockListSessions.mockReturnValue([
      {
        sessionKey: "agent:main:acp:session1",
        acp: {},
      },
      {
        sessionKey: "agent:main:acp:session2",
        acp: { runtimeSessionName: "named-session" },
      },
    ]);

    const result = await resolveSessionKey({ keyOrLabel: "named-session" });
    expect(result).toBe("agent:main:acp:session2");
  });

  it("should trim input before matching", async () => {
    mockListSessions.mockReturnValue([
      {
        sessionKey: "agent:main:acp:session1",
        acp: { runtimeSessionName: "test" },
      },
    ]);

    const result = await resolveSessionKey({ keyOrLabel: "  test  " });
    expect(result).toBe("agent:main:acp:session1");
  });
});
