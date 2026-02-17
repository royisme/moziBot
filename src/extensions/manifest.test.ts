import { describe, expect, it } from "vitest";
import { validateManifest } from "./manifest";

describe("validateManifest", () => {
  const validManifest = {
    id: "test-ext",
    version: "1.0.0",
    name: "Test Extension",
    description: "A test extension",
    tools: [
      {
        name: "test_tool",
        label: "Test Tool",
        description: "Does testing",
        parameters: {},
        execute: async () => ({
          content: [{ type: "text", text: "ok" }],
          details: {},
        }),
      },
    ],
  };

  it("validates a correct manifest", () => {
    const { manifest, diagnostics } = validateManifest(validManifest, "test");
    expect(manifest).not.toBeNull();
    expect(manifest?.id).toBe("test-ext");
    expect(manifest?.version).toBe("1.0.0");
    expect(manifest?.tools).toHaveLength(1);
    expect(diagnostics).toHaveLength(0);
  });

  it("rejects null input", () => {
    const { manifest, diagnostics } = validateManifest(null, "test");
    expect(manifest).toBeNull();
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.level).toBe("error");
  });

  it("rejects missing id", () => {
    const { manifest, diagnostics } = validateManifest({ ...validManifest, id: "" }, "test");
    expect(manifest).toBeNull();
    expect(diagnostics.some((d) => d.message.includes("id"))).toBe(true);
  });

  it("rejects missing version", () => {
    const { manifest, diagnostics } = validateManifest({ ...validManifest, version: "" }, "test");
    expect(manifest).toBeNull();
    expect(diagnostics.some((d) => d.message.includes("version"))).toBe(true);
  });

  it("rejects missing name", () => {
    const { manifest, diagnostics } = validateManifest({ ...validManifest, name: "" }, "test");
    expect(manifest).toBeNull();
    expect(diagnostics.some((d) => d.message.includes("name"))).toBe(true);
  });

  it("accepts manifest without tools when register callback exists", () => {
    const { manifest, diagnostics } = validateManifest(
      {
        id: "test",
        version: "1.0.0",
        name: "Test",
        register: () => {},
      },
      "test",
    );
    expect(manifest).not.toBeNull();
    expect(manifest?.tools).toEqual([]);
    expect(diagnostics.some((d) => d.level === "error")).toBe(false);
  });

  it("rejects tool without execute function", () => {
    const { manifest, diagnostics } = validateManifest(
      {
        ...validManifest,
        tools: [{ name: "bad_tool", label: "Bad", description: "Bad" }],
      },
      "test",
    );
    expect(manifest).toBeNull();
    expect(diagnostics.some((d) => d.message.includes("execute"))).toBe(true);
  });

  it("preserves skillDirs when provided", () => {
    const { manifest } = validateManifest(
      { ...validManifest, skillDirs: ["/path/to/skills"] },
      "test",
    );
    expect(manifest?.skillDirs).toEqual(["/path/to/skills"]);
  });

  it("accepts capabilities and lifecycle callbacks", () => {
    const { manifest, diagnostics } = validateManifest(
      {
        ...validManifest,
        capabilities: { tools: true, hooks: false },
        onStart: () => {},
        onStop: () => {},
        onReload: () => {},
      },
      "test",
    );
    expect(manifest).not.toBeNull();
    expect(manifest?.capabilities).toEqual({ tools: true, hooks: false });
    expect(typeof manifest?.onStart).toBe("function");
    expect(typeof manifest?.onStop).toBe("function");
    expect(typeof manifest?.onReload).toBe("function");
    expect(diagnostics.some((diag) => diag.level === "error")).toBe(false);
  });

  it("warns for unknown capability keys", () => {
    const { manifest, diagnostics } = validateManifest(
      {
        ...validManifest,
        capabilities: { tools: true, unknownFlag: true },
      },
      "test",
    );
    expect(manifest).not.toBeNull();
    expect(diagnostics.some((diag) => diag.message.includes("unknown capabilities key"))).toBe(
      true,
    );
  });

  it("warns for non-function lifecycle fields", () => {
    const { manifest, diagnostics } = validateManifest(
      {
        ...validManifest,
        onStart: "bad",
      },
      "test",
    );
    expect(manifest).not.toBeNull();
    expect(diagnostics.some((diag) => diag.message.includes("onStart should be a function"))).toBe(
      true,
    );
  });
});
