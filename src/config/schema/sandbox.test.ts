import { describe, expect, it } from "vitest";
import { SandboxSchema } from "./sandbox";

describe("SandboxSchema", () => {
  it("accepts mode off", () => {
    const result = SandboxSchema.safeParse({
      mode: "off",
      autoBootstrapOnStart: true,
      workspaceAccess: "rw",
    });
    expect(result.success).toBe(true);
  });

  it("accepts mode docker", () => {
    const result = SandboxSchema.safeParse({
      mode: "docker",
      workspaceAccess: "rw",
      docker: { image: "mozi-sandbox-common:bun1.3" },
    });
    expect(result.success).toBe(true);
  });

  it("accepts mode apple-vm", () => {
    const result = SandboxSchema.safeParse({
      mode: "apple-vm",
      workspaceAccess: "rw",
      apple: { image: "mozi-sandbox-common:bun1.3" },
    });
    expect(result.success).toBe(true);
  });

  it("accepts apple-vm vibebox backend config", () => {
    const result = SandboxSchema.safeParse({
      mode: "apple-vm",
      workspaceAccess: "rw",
      apple: {
        backend: "vibebox",
        vibebox: {
          enabled: true,
          binPath: "/usr/local/bin/vibebox",
          timeoutSeconds: 90,
          provider: "apple-vm",
        },
      },
    });
    expect(result.success).toBe(true);
  });

  it("accepts vibebox provider off and docker", () => {
    const offResult = SandboxSchema.safeParse({
      mode: "off",
      apple: {
        vibebox: {
          provider: "off",
        },
      },
    });
    const dockerResult = SandboxSchema.safeParse({
      mode: "docker",
      apple: {
        vibebox: {
          provider: "docker",
        },
      },
    });
    expect(offResult.success).toBe(true);
    expect(dockerResult.success).toBe(true);
  });

  it("rejects legacy enabled flag", () => {
    const result = SandboxSchema.safeParse({
      enabled: true,
      workspaceAccess: "rw",
    });
    expect(result.success).toBe(false);
  });
});
