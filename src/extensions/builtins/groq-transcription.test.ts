import { describe, expect, it } from "vitest";
import type { ExtensionsConfig } from "../../config/schema/extensions";
import { loadExtensions } from "../loader";
import "../builtins";

describe("groq-transcription extension", () => {
  it("returns error when API key is not set", async () => {
    const savedKey = process.env.GROQ_API_KEY;
    delete process.env.GROQ_API_KEY;

    try {
      const config: ExtensionsConfig = {
        enabled: true,
        entries: {
          "groq-transcription": { enabled: true },
        },
      };
      const registry = loadExtensions(config);
      const ext = registry.get("groq-transcription");
      expect(ext).toBeDefined();
      const tool = ext?.tools.find((t) => t.name === "groq_transcribe_audio");
      expect(tool).toBeDefined();
      if (!tool) {
        return;
      }
      const result = await tool.execute("call-1", { filePath: "./missing-audio.m4a" });
      const first = result.content[0];
      const text = first?.type === "text" ? first.text : "";
      expect(text).toContain("GROQ_API_KEY");
      expect(text.toLowerCase()).toContain("not found");
    } finally {
      if (savedKey !== undefined) {
        process.env.GROQ_API_KEY = savedKey;
      }
    }
  });
});
