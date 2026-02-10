import { describe, expect, it } from "vitest";
import { MoziConfigSchema } from "./index";

describe("Extensions schema", () => {
  it("accepts a complete extensions config", () => {
    const result = MoziConfigSchema.safeParse({
      extensions: {
        enabled: true,
        allow: ["web-tavily"],
        deny: [],
        load: {
          paths: ["~/.mozi/extensions"],
        },
        entries: {
          "web-tavily": {
            enabled: true,
            config: {
              apiKeyEnv: "TAVILY_API_KEY",
              baseUrl: "https://api.tavily.com",
              defaultMaxResults: 5,
            },
          },
        },
        installs: {
          "web-tavily": {
            source: "npm",
            spec: "@mozi/ext-web-tavily@^1.0.0",
            installedAt: "2026-02-07T00:00:00.000Z",
          },
        },
        mcpServers: {
          "tavily-mcp": {
            command: "npx",
            args: ["-y", "tavily-mcp@latest"],
            env: {
              TAVILY_API_KEY: "tvly-test",
            },
            enabled: true,
            timeout: 30000,
          },
        },
      },
    });

    expect(result.success).toBe(true);
  });

  it("accepts minimal extensions config", () => {
    const result = MoziConfigSchema.safeParse({
      extensions: {
        enabled: true,
      },
    });

    expect(result.success).toBe(true);
  });

  it("accepts empty extensions object", () => {
    const result = MoziConfigSchema.safeParse({
      extensions: {},
    });

    expect(result.success).toBe(true);
  });

  it("rejects unknown fields in extensions", () => {
    const result = MoziConfigSchema.safeParse({
      extensions: {
        enabled: true,
        unknownField: "test",
      },
    });

    expect(result.success).toBe(false);
  });

  it("rejects invalid install source", () => {
    const result = MoziConfigSchema.safeParse({
      extensions: {
        installs: {
          "web-tavily": {
            source: "invalid-source",
            spec: "test",
          },
        },
      },
    });

    expect(result.success).toBe(false);
  });

  it("accepts all valid install sources", () => {
    for (const source of ["npm", "path", "archive", "git"]) {
      const result = MoziConfigSchema.safeParse({
        extensions: {
          installs: {
            test: { source, spec: "test-spec" },
          },
        },
      });

      expect(result.success).toBe(true);
    }
  });

  it("rejects unknown fields in extension entry", () => {
    const result = MoziConfigSchema.safeParse({
      extensions: {
        entries: {
          test: {
            enabled: true,
            unknownField: "oops",
          },
        },
      },
    });

    expect(result.success).toBe(false);
  });
});
