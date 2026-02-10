import { describe, expect, it } from "vitest";
import type { MoziConfig } from "../../config";
import { bootstrapSandboxes } from "./bootstrap";

describe("sandbox bootstrap", () => {
  it("pulls docker image when missing in fix mode", async () => {
    const calls: string[] = [];
    const config: MoziConfig = {
      agents: {
        main: {
          sandbox: {
            mode: "docker",
            docker: { image: "mozi-sandbox-common:bun1.3" },
          },
        },
      },
    };

    const result = await bootstrapSandboxes(config, {
      fix: true,
      runCommand: async ({ command, args }) => {
        calls.push(`${command} ${args.join(" ")}`);
        if (command === "docker" && args[0] === "info") {
          return { stdout: "ok", stderr: "", exitCode: 0 };
        }
        if (command === "docker" && args[0] === "image" && args[1] === "inspect") {
          return { stdout: "", stderr: "not found", exitCode: 1 };
        }
        if (command === "docker" && args[0] === "pull") {
          return { stdout: "pulled", stderr: "", exitCode: 0 };
        }
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    });

    expect(result.ok).toBe(true);
    expect(calls.some((line) => line.includes("docker pull mozi-sandbox-common:bun1.3"))).toBe(
      true,
    );
  });

  it("respects onlyAutoEnabled filter", async () => {
    const config: MoziConfig = {
      agents: {
        defaults: {
          sandbox: {
            mode: "docker",
            docker: { image: "mozi-sandbox-common:bun1.3" },
            autoBootstrapOnStart: false,
          },
        },
        main: {},
      },
    };

    const result = await bootstrapSandboxes(config, {
      onlyAutoEnabled: true,
      runCommand: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
    });

    expect(result.attempted).toBe(0);
  });

  it("supports vibebox off provider path", async () => {
    const config: MoziConfig = {
      agents: {
        main: {
          workspace: "/tmp",
          sandbox: {
            mode: "off",
            apple: {
              vibebox: {
                enabled: true,
                provider: "off",
              },
            },
          },
        },
      },
    };

    const result = await bootstrapSandboxes(config, {
      fix: false,
      runCommand: async ({ command, args }) => {
        if (command === "vibebox" && args[0] === "probe") {
          return {
            stdout: JSON.stringify({
              ok: true,
              selected: "off",
              diagnostics: {
                off: { available: true },
              },
            }),
            stderr: "",
            exitCode: 0,
          };
        }
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    });

    expect(result.ok).toBe(true);
    expect(result.actions.some((x) => x.message.includes("provider=off"))).toBe(true);
  });
});
