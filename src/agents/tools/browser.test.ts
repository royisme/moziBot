import { describe, expect, it } from "vitest";
import { browserToolSchema } from "./browser";

describe("browser tool schema", () => {
  it("requires url for navigate", () => {
    const result = browserToolSchema.safeParse({ action: "navigate" });
    expect(result.success).toBe(false);
  });

  it("requires expression for evaluate", () => {
    const result = browserToolSchema.safeParse({ action: "evaluate" });
    expect(result.success).toBe(false);
  });

  it("requires selector or coordinates for click", () => {
    const result = browserToolSchema.safeParse({ action: "click" });
    expect(result.success).toBe(false);
  });

  it("accepts click with coordinates", () => {
    const result = browserToolSchema.safeParse({ action: "click", x: 12, y: 34 });
    expect(result.success).toBe(true);
  });

  it("requires text for type", () => {
    const result = browserToolSchema.safeParse({ action: "type" });
    expect(result.success).toBe(false);
  });

  it("requires jpeg for screenshot quality", () => {
    const result = browserToolSchema.safeParse({
      action: "screenshot",
      screenshot: { quality: 80 },
    });
    expect(result.success).toBe(false);
  });

  it("accepts screenshot jpeg quality", () => {
    const result = browserToolSchema.safeParse({
      action: "screenshot",
      screenshot: { format: "jpeg", quality: 80 },
    });
    expect(result.success).toBe(true);
  });
});
