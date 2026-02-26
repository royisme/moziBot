import { describe, expect, it } from "vitest";
import type { MoziConfig } from "./schema";
import { resolveAgentModelRouting } from "./model-routing";

describe("model routing", () => {
  it("preserves explicit empty fallbacks override", () => {
    const config = {
      agents: {
        defaults: {
          model: {
            primary: "openai/gpt-4o",
            fallbacks: ["openai/gpt-4o-mini"],
          },
        },
        mozi: {
          model: {
            primary: "openai/gpt-4.1",
            fallbacks: [],
          },
        },
      },
    } as MoziConfig;

    const routing = resolveAgentModelRouting(config, "mozi");
    expect(routing.defaultModel.primary).toBe("openai/gpt-4.1");
    expect(routing.defaultModel.fallbacks).toEqual([]);
  });

  it("resolves fast model from defaults when provided", () => {
    const config = {
      agents: {
        defaults: {
          fastModel: {
            primary: "openai/gpt-4o-mini",
            fallbacks: ["openai/gpt-4o"],
          },
        },
        mozi: {
          model: "openai/gpt-4.1",
        },
      },
    } as MoziConfig;

    const routing = resolveAgentModelRouting(config, "mozi");
    expect(routing.fastModel.primary).toBe("openai/gpt-4o-mini");
    expect(routing.fastModel.fallbacks).toEqual(["openai/gpt-4o"]);
  });
});
