import { describe, expect, it } from "vitest";
import { RunBuffer } from "./run-buffer";

describe("RunBuffer", () => {
  it("aggregates text_delta chunks in order", () => {
    const buffer = new RunBuffer();
    buffer.append("Hello");
    buffer.append(" ");
    buffer.append("world");

    expect(buffer.snapshot()).toBe("Hello world");
  });

  it("replaces with terminal projection text", () => {
    const buffer = new RunBuffer();
    buffer.append("partial");
    buffer.replaceWith("final");

    expect(buffer.snapshot()).toBe("final");
  });

  it("trims oldest content when exceeding max chars", () => {
    const buffer = new RunBuffer(5);
    buffer.append("abc");
    buffer.append("def");

    expect(buffer.snapshot()).toBe("bcdef");
  });
});
