import { describe, expect, it } from "vitest";
import { MoziConfigSchema } from "./index";

describe("Skills schema", () => {
  it("maps legacy bun nodeManager to pnpm", () => {
    const result = MoziConfigSchema.safeParse({
      skills: {
        install: {
          nodeManager: "bun",
        },
      },
    });

    expect(result.success).toBe(true);
    if (!result.success) {
      return;
    }
    expect(result.data.skills?.install?.nodeManager).toBe("pnpm");
  });
});
