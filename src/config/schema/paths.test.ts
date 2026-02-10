import { describe, expect, it } from "vitest";
import { MoziConfigSchema } from "./index";

describe("Paths schema", () => {
  it("accepts workspace compatibility path", () => {
    const result = MoziConfigSchema.safeParse({
      paths: {
        baseDir: "~/.mozi",
        workspace: "./workspace",
      },
    });
    expect(result.success).toBe(true);
  });
});
