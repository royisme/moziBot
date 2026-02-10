import { describe, expect, it } from "vitest";
import type { ExtensionsConfig } from "../../config/schema/extensions";
import { loadExtensions } from "../loader";
import "../builtins";

describe("brave-search extension", () => {
  it("returns error when API key is not set", async () => {
    const savedKey = process.env.BRAVE_API_KEY;
    delete process.env.BRAVE_API_KEY;

    try {
      const config: ExtensionsConfig = {
        enabled: true,
        entries: {
          "brave-search": { enabled: true },
        },
      };
      const registry = loadExtensions(config);
      const ext = registry.get("brave-search");
      expect(ext).toBeDefined();
      const tool = ext?.tools.find((t) => t.name === "brave_search");
      expect(tool).toBeDefined();
      if (!tool) {
        return;
      }
      const result = await tool.execute("call-1", { query: "brave search" });
      const text = result.content[0]?.text || "";
      expect(text).toContain("BRAVE_API_KEY");
      expect(text.toLowerCase()).toContain("not found");
      expect(text).toContain("mozi auth set brave");
    } finally {
      if (savedKey !== undefined) {
        process.env.BRAVE_API_KEY = savedKey;
      }
    }
  });
});
