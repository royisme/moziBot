import { Type } from "@sinclair/typebox";
import { z } from "zod";
import type { ExtensionManifest, ExtensionToolContext, ExtensionToolDefinition } from "../types";
import { registerBuiltinExtension } from "../loader";

// ---- Config schema ----

const BraveSearchConfigSchema = z.object({
  apiKeyEnv: z.string().default("BRAVE_API_KEY"),
  baseUrl: z.string().default("https://api.search.brave.com"),
  defaultMaxResults: z.number().int().min(1).max(20).default(5),
  timeout: z.number().int().min(1000).max(60000).default(15000),
});

type BraveSearchConfig = z.infer<typeof BraveSearchConfigSchema>;

// ---- Brave API types ----

type BraveWebResult = {
  title: string;
  url: string;
  description: string;
  age?: string;
  extra_snippets?: string[];
};

type BraveSearchResponse = {
  query?: { original: string };
  web?: { results: BraveWebResult[] };
};

// ---- Tool implementation ----

function resolveApiKey(config: BraveSearchConfig): string {
  const envName = config.apiKeyEnv;
  const key = process.env[envName];
  if (!key) {
    throw new Error(`Brave Search API key not found (${envName}). Run: mozi auth set brave`);
  }
  return key;
}

function parseConfig(raw: Record<string, unknown>): BraveSearchConfig {
  const result = BraveSearchConfigSchema.safeParse(raw);
  if (!result.success) {
    return BraveSearchConfigSchema.parse({});
  }
  return result.data;
}

async function executeBraveSearch(
  _toolCallId: string,
  args: Record<string, unknown>,
  ctx: ExtensionToolContext,
): Promise<{ content: Array<{ type: string; text: string }>; details: Record<string, unknown> }> {
  const config = parseConfig(ctx.extensionConfig);

  const query = args.query;
  if (typeof query !== "string" || query.trim().length === 0) {
    return {
      content: [{ type: "text", text: "Error: query parameter is required and must be non-empty" }],
      details: {},
    };
  }

  let apiKey: string;
  try {
    apiKey = resolveApiKey(config);
  } catch (error) {
    return {
      content: [
        {
          type: "text",
          text: error instanceof Error ? error.message : "Failed to resolve Brave API key",
        },
      ],
      details: {},
    };
  }

  const maxResults =
    typeof args.maxResults === "number" ? args.maxResults : config.defaultMaxResults;

  const params = new URLSearchParams({
    q: query.trim(),
    count: String(maxResults),
  });

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), config.timeout);

    const response = await fetch(`${config.baseUrl}/res/v1/web/search?${params.toString()}`, {
      method: "GET",
      headers: {
        Accept: "application/json",
        "Accept-Encoding": "gzip",
        "X-Subscription-Token": apiKey,
      },
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const errorText = await response.text().catch(() => "unknown error");
      return {
        content: [
          {
            type: "text",
            text: `Brave Search API error (${response.status}): ${errorText}`,
          },
        ],
        details: { statusCode: response.status },
      };
    }

    const data = (await response.json()) as BraveSearchResponse;
    const results = data.web?.results ?? [];

    // Format as readable text for the model
    const lines: string[] = [];
    for (const [i, result] of results.entries()) {
      lines.push(`[${i + 1}] ${result.title}`);
      lines.push(`    URL: ${result.url}`);
      lines.push(`    ${result.description}`);
      if (result.age) {
        lines.push(`    Age: ${result.age}`);
      }
      lines.push("");
    }

    if (lines.length === 0) {
      lines.push(`No results found for: "${query}"`);
    }

    const normalized = {
      query: data.query?.original ?? query,
      results: results.map((r) => ({
        title: r.title,
        url: r.url,
        contentSnippet: r.description,
        age: r.age,
      })),
    };

    return {
      content: [{ type: "text", text: lines.join("\n").trimEnd() }],
      details: normalized as unknown as Record<string, unknown>,
    };
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      return {
        content: [
          {
            type: "text",
            text: `Brave search timed out after ${config.timeout}ms for query: "${query}"`,
          },
        ],
        details: {},
      };
    }
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: "text", text: `Brave search failed: ${message}` }],
      details: {},
    };
  }
}

// ---- Tool definitions ----

const braveSearchTool: ExtensionToolDefinition = {
  name: "brave_search",
  label: "Brave Search",
  description:
    "Search the web using Brave Search API. Returns a list of relevant results with titles, URLs, and descriptions.",
  parameters: Type.Object({
    query: Type.String({ minLength: 1, description: "The search query" }),
    maxResults: Type.Optional(
      Type.Number({
        minimum: 1,
        maximum: 20,
        description: "Maximum number of results to return (default: 5)",
      }),
    ),
  }),
  execute: executeBraveSearch,
};

// ---- Extension factory ----

function createBraveSearchExtension(_config: Record<string, unknown>): ExtensionManifest {
  return {
    id: "brave-search",
    version: "1.0.0",
    name: "Brave Web Search",
    description:
      "Provides web search capabilities via the Brave Search API. Requires BRAVE_API_KEY environment variable.",
    configSchema: BraveSearchConfigSchema,
    tools: [braveSearchTool],
  };
}

// Self-register as a builtin extension
registerBuiltinExtension("brave-search", createBraveSearchExtension);
