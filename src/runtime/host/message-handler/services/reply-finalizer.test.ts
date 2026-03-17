import { describe, expect, it } from "vitest";
import {
  isSystemInternalTurnSource,
  shouldSuppressHeartbeatReply,
  shouldSuppressSilentReply,
} from "./reply-finalizer";

describe("reply-finalizer suppression policy", () => {
  it("suppresses silent token replies", () => {
    expect(shouldSuppressSilentReply("NO_REPLY")).toBe(true);
    expect(shouldSuppressSilentReply(" NO_REPLY ")).toBe(true);
    expect(shouldSuppressSilentReply("normal answer")).toBe(false);
  });

  it("does not suppress silent token when forceReply=true", () => {
    expect(shouldSuppressSilentReply("NO_REPLY", { forceReply: true })).toBe(false);
  });

  it("suppresses heartbeat HEARTBEAT_OK replies only for heartbeat source", () => {
    expect(shouldSuppressHeartbeatReply({ source: "heartbeat" }, "HEARTBEAT_OK")).toBe(true);
    expect(shouldSuppressHeartbeatReply({ source: "heartbeat" }, " HEARTBEAT_OK ")).toBe(true);
    expect(shouldSuppressHeartbeatReply({ source: "message" }, "HEARTBEAT_OK")).toBe(false);
    expect(shouldSuppressHeartbeatReply(undefined, "HEARTBEAT_OK")).toBe(false);
    expect(shouldSuppressHeartbeatReply({ source: "heartbeat" }, "all good")).toBe(false);
  });

  it("classifies only real execution-flow internal sources as system-internal", () => {
    expect(isSystemInternalTurnSource("heartbeat")).toBe(true);
    expect(isSystemInternalTurnSource("heartbeat-wake")).toBe(true);
    expect(isSystemInternalTurnSource("subagent-announce")).toBe(true);

    expect(isSystemInternalTurnSource("detached-run-announce")).toBe(false);
    expect(isSystemInternalTurnSource("watchdog")).toBe(false);
    expect(isSystemInternalTurnSource("message")).toBe(false);
    expect(isSystemInternalTurnSource(undefined)).toBe(false);
  });
});
