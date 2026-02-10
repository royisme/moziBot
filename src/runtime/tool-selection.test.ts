import { describe, expect, it } from "vitest";
import { filterTools, resolveToolAllowList } from "./tool-selection";

describe("resolveToolAllowList", () => {
  it("prefers agent tools when defined", () => {
    const result = resolveToolAllowList({
      agentTools: ["memory_search"],
      defaultTools: ["sessions_list"],
      fallbackTools: ["exec"],
    });
    expect(result).toEqual(["memory_search"]);
  });

  it("falls back to defaults when agent tools are undefined", () => {
    const result = resolveToolAllowList({
      defaultTools: ["sessions_list"],
      fallbackTools: ["exec"],
    });
    expect(result).toEqual(["sessions_list"]);
  });

  it("uses fallback tools when no config is set", () => {
    const result = resolveToolAllowList({
      fallbackTools: ["exec"],
    });
    expect(result).toEqual(["exec"]);
  });

  it("always appends required tools", () => {
    const result = resolveToolAllowList({
      agentTools: ["memory_search"],
      fallbackTools: ["sessions_list"],
      requiredTools: ["exec"],
    });
    expect(result).toEqual(["memory_search", "exec"]);
  });
});

describe("filterTools", () => {
  it("filters by allowed list and reports missing", () => {
    const available = [{ name: "a" }, { name: "b" }];
    const { tools, missing } = filterTools(available, ["b", "c"]);
    expect(tools.map((tool) => tool.name)).toEqual(["b"]);
    expect(missing).toEqual(["c"]);
  });
});
