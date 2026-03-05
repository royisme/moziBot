import { describe, expect, it } from "vitest";
import { DefaultRuntimeErrorPolicy } from "./error-policy";

describe("DefaultRuntimeErrorPolicy", () => {
  it("retries busy errors with bounded backoff", () => {
    const policy = new DefaultRuntimeErrorPolicy(3, 1000);
    const error = new Error(
      "Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.",
    );

    expect(policy.decide(error, 1)).toEqual({ retry: true, delayMs: 2000, reason: "busy_error" });
    expect(policy.decide(error, 3)).toEqual({ retry: false, delayMs: 0, reason: "terminal_error" });
  });

  it("prefers retry-after over exponential backoff", () => {
    const policy = new DefaultRuntimeErrorPolicy(4, 1000);
    const error = new Error("503 service unavailable; retry-after: 7");

    expect(policy.decide(error, 1)).toEqual({ retry: true, delayMs: 7000, reason: "transient_error" });
  });

  it("does not retry auth/billing/capability errors", () => {
    const policy = new DefaultRuntimeErrorPolicy(4, 1000);

    expect(policy.decide(new Error("401 unauthorized"), 1)).toEqual({
      retry: false,
      delayMs: 0,
      reason: "auth_billing_error",
    });
    expect(policy.decide(new Error("unsupported input image_url"), 1)).toEqual({
      retry: false,
      delayMs: 0,
      reason: "capability_error",
    });
  });
});
