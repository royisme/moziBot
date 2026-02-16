import { describe, expect, it } from "vitest";
import { shouldSuppressHeartbeatReply, shouldSuppressSilentReply } from "./reply-finalizer";

describe("reply-finalizer suppression policy", () => {
  it("suppresses silent token replies", () => {
    expect(shouldSuppressSilentReply("NO_REPLY")).toBe(true);
    expect(shouldSuppressSilentReply(" NO_REPLY ")).toBe(true);
    expect(shouldSuppressSilentReply("normal answer")).toBe(false);
  });

  it("suppresses heartbeat HEARTBEAT_OK replies only for heartbeat source", () => {
    expect(shouldSuppressHeartbeatReply({ source: "heartbeat" }, "HEARTBEAT_OK")).toBe(true);
    expect(shouldSuppressHeartbeatReply({ source: "heartbeat" }, " HEARTBEAT_OK ")).toBe(true);
    expect(shouldSuppressHeartbeatReply({ source: "message" }, "HEARTBEAT_OK")).toBe(false);
    expect(shouldSuppressHeartbeatReply(undefined, "HEARTBEAT_OK")).toBe(false);
    expect(shouldSuppressHeartbeatReply({ source: "heartbeat" }, "all good")).toBe(false);
  });
});
