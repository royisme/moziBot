import { Type } from "@sinclair/typebox";
import { z } from "zod";
import type { ExtensionManifest, ExtensionToolContext, ExtensionToolDefinition } from "../types";
import { detectSuspiciousPatterns, wrapExternalContent } from "../../security/external-content";
import { registerBuiltinExtension } from "../loader";

// ---- Config schema ----

const TavilyConfigSchema = z.object({
  apiKeyEnv: z.string().default("TAVILY_API_KEY"),
  baseUrl: z.string().default("https://api.tavily.com"),
  defaultMaxResults: z.number().int().min(1).max(20).default(5),
  includeAnswer: z.boolean().default(true),
  topic: z.enum(["general", "news"]).default("general"),
  timeout: z.number().int().min(1000).max(60000).default(15000),
});

type TavilyConfig = z.infer<typeof TavilyConfigSchema>;

// ---- Tavily API types ----

type TavilySearchResult = {
  title: string;
  url: string;
  content: string;
  score: number;
  published_date?: string;
  raw_content?: string;
};

type TavilySearchResponse = {
  answer?: string;
  query: string;
  results: TavilySearchResult[];
  response_time: number;
};

// ---- Normalized output ----

type NormalizedResult = {
  title: string;
  url: string;
  contentSnippet: string;
  score: number;
  publishedTime?: string;
};

type WebSearchOutput = {
  summary?: string;
  results: NormalizedResult[];
  query: string;
  responseTime: number;
};

// ---- Tool implementation ----

function resolveApiKey(config: TavilyConfig): string {
  const envName = config.apiKeyEnv;
  const key = process.env[envName];
  if (!key) {
    throw new Error(`Tavily API key not found (${envName}). Run: mozi auth set tavily`);
  }
  return key;
}

function parseConfig(raw: Record<string, unknown>): TavilyConfig {
  const result = TavilyConfigSchema.safeParse(raw);
  if (!result.success) {
    // Use defaults for any unprovided fields
    return TavilyConfigSchema.parse({});
  }
  return result.data;
}

async function executeWebSearch(
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
          text: error instanceof Error ? error.message : "Failed to resolve Tavily API key",
        },
      ],
      details: {},
    };
  }

  const maxResults =
    typeof args.maxResults === "number" ? args.maxResults : config.defaultMaxResults;
  const topic = typeof args.topic === "string" ? args.topic : config.topic;
  const includeAnswer =
    typeof args.includeAnswer === "boolean" ? args.includeAnswer : config.includeAnswer;
  const includeRawContent = args.includeRawContent === true;

  const requestBody = {
    api_key: apiKey,
    query: query.trim(),
    max_results: maxResults,
    topic,
    include_answer: includeAnswer,
    include_raw_content: includeRawContent,
  };

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), config.timeout);

    const response = await fetch(`${config.baseUrl}/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestBody),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const errorText = await response.text().catch(() => "unknown error");
      // Redact API key from any error response
      const safeError = errorText.replace(/tvly-[a-zA-Z0-9]+/g, "tvly-***REDACTED***");
      return {
        content: [
          {
            type: "text",
            text: `Tavily API error (${response.status}): ${safeError}`,
          },
        ],
        details: { statusCode: response.status },
      };
    }

    const data = (await response.json()) as TavilySearchResponse;

    const normalized: WebSearchOutput = {
      summary: data.answer || undefined,
      query: data.query,
      responseTime: data.response_time,
      results: data.results.map((r) => ({
        title: r.title,
        url: r.url,
        contentSnippet: r.content,
        score: r.score,
        publishedTime: r.published_date || undefined,
      })),
    };

    // Format as readable text for the model
    const lines: string[] = [];
    if (normalized.summary) {
      lines.push(`Summary: ${normalized.summary}`);
      lines.push("");
    }
    for (const [i, result] of normalized.results.entries()) {
      lines.push(`[${i + 1}] ${result.title}`);
      lines.push(`    URL: ${result.url}`);
      lines.push(`    ${result.contentSnippet}`);
      if (result.publishedTime) {
        lines.push(`    Published: ${result.publishedTime}`);
      }
      lines.push("");
    }
    const rawText = lines.join("\n").trimEnd();
    const suspiciousPatterns = detectSuspiciousPatterns(rawText);
    const wrappedText = wrapExternalContent(rawText, {
      source: "web_search",
      metadata: {
        Query: normalized.query,
      },
    });
    const safeDetails: Record<string, unknown> = {
      ...normalized,
      externalContent: {
        untrusted: true,
        source: "web_search",
        wrapped: true,
      },
    };
    if (suspiciousPatterns.length > 0) {
      safeDetails.suspiciousPatterns = suspiciousPatterns;
    }

    return {
      content: [{ type: "text", text: wrappedText }],
      details: safeDetails,
    };
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      return {
        content: [
          {
            type: "text",
            text: `Tavily search timed out after ${config.timeout}ms for query: "${query}"`,
          },
        ],
        details: {},
      };
    }
    const message = error instanceof Error ? error.message : String(error);
    // Redact any API key that may appear in error messages
    const safeMessage = message.replace(/tvly-[a-zA-Z0-9]+/g, "tvly-***REDACTED***");
    return {
      content: [{ type: "text", text: `Tavily search failed: ${safeMessage}` }],
      details: {},
    };
  }
}

// ---- Tool definitions ----

const webSearchTool: ExtensionToolDefinition = {
  name: "web_search",
  label: "Web Search",
  description:
    "Search the web for current information using Tavily. Returns a summary and list of relevant results with titles, URLs, and content snippets.",
  parameters: Type.Object({
    query: Type.String({ minLength: 1, description: "The search query" }),
    maxResults: Type.Optional(
      Type.Number({
        minimum: 1,
        maximum: 20,
        description: "Maximum number of results to return (default: 5)",
      }),
    ),
    topic: Type.Optional(
      Type.Union([Type.Literal("general"), Type.Literal("news")], {
        description: 'Search topic: "general" or "news"',
      }),
    ),
    includeAnswer: Type.Optional(
      Type.Boolean({ description: "Whether to include a synthesized answer (default: true)" }),
    ),
    includeRawContent: Type.Optional(
      Type.Boolean({ description: "Whether to include raw page content (default: false)" }),
    ),
  }),
  execute: executeWebSearch,
};

// ---- Extension factory ----

function createWebTavilyExtension(_config: Record<string, unknown>): ExtensionManifest {
  return {
    id: "web-tavily",
    version: "1.0.0",
    name: "Tavily Web Search",
    description:
      "Provides web search capabilities via the Tavily API. Requires TAVILY_API_KEY environment variable.",
    configSchema: TavilyConfigSchema,
    tools: [webSearchTool],
  };
}

// Self-register as a builtin extension
registerBuiltinExtension("web-tavily", createWebTavilyExtension);
