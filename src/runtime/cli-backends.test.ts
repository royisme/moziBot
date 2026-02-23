import { describe, expect, it } from "vitest";
import type { MoziConfig } from "../config";
import { listCliBackendModels } from "./cli-backends";

describe("cli backends", () => {
  it("exposes default cli models", () => {
    const models = listCliBackendModels({} as MoziConfig);
    const refs = models.map((m) => `${m.provider}/${m.id}`);
    expect(refs).toContain("claude-cli/opus-4.6");
    expect(refs).toContain("codex-cli/gpt-5.2-codex");
  });

  it("allows overrides via config", () => {
    const config = {
      agents: {
        defaults: {
          cliBackends: {
            "my-cli": {
              command: "/usr/local/bin/my-cli",
              models: ["alpha", "beta"],
            },
          },
        },
      },
    } as MoziConfig;

    const models = listCliBackendModels(config);
    const refs = models.map((m) => `${m.provider}/${m.id}`);
    expect(refs).toContain("my-cli/alpha");
    expect(refs).toContain("my-cli/beta");
  });
});
