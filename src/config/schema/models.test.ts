import { describe, expect, it } from "vitest";
import { MoziConfigSchema } from "./index";

describe("Models schema", () => {
  it("accepts global models.aliases config", () => {
    const result = MoziConfigSchema.safeParse({
      models: {
        providers: {
          quotio: {
            models: [{ id: "gemini-3-flash-preview", name: "gemini-3-flash-preview" }],
          },
        },
        aliases: {
          flash: "quotio/gemini-3-flash-preview",
          seedCode: "volcengine/doubao-seed-2-0-code-preview-260215",
        },
      },
    });

    expect(result.success).toBe(true);
  });

  it("rejects alias keys containing '/'", () => {
    const result = MoziConfigSchema.safeParse({
      models: {
        aliases: {
          "quotio/flash": "quotio/gemini-3-flash-preview",
        },
      },
    });

    expect(result.success).toBe(false);
    if (result.success) {
      return;
    }
    expect(result.error.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: ["models", "aliases", "quotio/flash"],
          message: "Model alias key cannot contain '/'.",
        }),
      ]),
    );
  });
});
