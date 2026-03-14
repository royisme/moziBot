import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import { z } from "zod";
import { detectSuspiciousPatterns, wrapWebContent } from "../../security/external-content";
import { registerBuiltinExtension } from "../loader";
import type { ExtensionManifest, ExtensionToolContext, ExtensionToolDefinition } from "../types";

type ExtensionToolResult = AgentToolResult<unknown>;

// ---- Config schema ----

const WebFetchConfigSchema = z.object({
  firecrawlApiKeyEnv: z.string().default("FIRECRAWL_API_KEY"),
  firecrawlBaseUrl: z.string().default("https://api.firecrawl.dev"),
  timeout: z.number().int().min(1000).max(60000).default(15000),
  maxResponseBytes: z.number().int().min(10000).max(5000000).default(2000000),
  maxRedirects: z.number().int().min(0).max(10).default(5),
  maxChars: z.number().int().min(100).max(100000).default(50000),
});

type WebFetchConfig = z.infer<typeof WebFetchConfigSchema>;

// ---- Constants ----

const PRIVATE_IP_PATTERNS = [
  /^127\./, // Loopback
  /^10\./, // Private Class A
  /^172\.(1[6-9]|2\d|3[01])\./, // Private Class B
  /^192\.168\./, // Private Class C
  /^169\.254\./, // Link-local
  /^0\./, // Private
  /^::1$/, // IPv6 loopback
  /^fc00:/i, // IPv6 private
  /^fe80:/i, // IPv6 link-local
];

const BLOCKED_HOSTS = [
  "localhost",
  "localhost.localdomain",
  "metadata.google.internal",
  "metadata.google",
  "169.254.169.254", // Cloud metadata
  "metadata.aws.internal",
  "instance-data.vmware-local",
];

// ---- Helper functions ----

function parseConfig(raw: Record<string, unknown>): WebFetchConfig {
  const result = WebFetchConfigSchema.safeParse(raw);
  if (!result.success) {
    return WebFetchConfigSchema.parse({});
  }
  return result.data;
}

function isPrivateIpOrHost(hostname: string, ip?: string): boolean {
  const checkHost = (ip || hostname).toLowerCase();

  if (BLOCKED_HOSTS.some((blocked) => checkHost === blocked || checkHost.endsWith(`.${blocked}`))) {
    return true;
  }

  for (const pattern of PRIVATE_IP_PATTERNS) {
    if (pattern.test(checkHost)) {
      return true;
    }
  }

  return false;
}

export type ResolvedAddress = { address: string; family: number };

async function defaultHostnameLookup(hostname: string): Promise<ResolvedAddress[]> {
  const dns = await import("node:dns").then((m) => m.promises);
  return (await dns.lookup(hostname, { all: true, verbatim: true })) as ResolvedAddress[];
}

let hostnameLookup: (hostname: string) => Promise<ResolvedAddress[]> = defaultHostnameLookup;

async function validateResolvedHostname(hostname: string): Promise<boolean> {
  if (isPrivateIpOrHost(hostname)) {
    return false;
  }

  try {
    const addresses = await hostnameLookup(hostname);
    for (const entry of addresses) {
      if (isPrivateIpOrHost(hostname, entry.address)) {
        return false;
      }
    }
  } catch {
    // Best-effort validation; leave final connect behavior to fetch.
  }

  return true;
}

export const __testing = {
  setHostnameLookupForTests(lookup: (hostname: string) => Promise<ResolvedAddress[]>): void {
    hostnameLookup = lookup;
  },
  resetHostnameLookupForTests(): void {
    hostnameLookup = defaultHostnameLookup;
  },
};

function resolveFirecrawlApiKey(config: WebFetchConfig): string | undefined {
  const envName = config.firecrawlApiKeyEnv;
  return process.env[envName];
}

// ---- HTML extraction ----

function decodeEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/gi, (_, dec) => String.fromCharCode(Number.parseInt(dec, 10)));
}

function stripTags(value: string): string {
  return decodeEntities(value.replace(/<[^>]+>/g, ""));
}

function normalizeWhitespace(value: string): string {
  return value
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function htmlToMarkdown(html: string): { text: string; title?: string } {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? normalizeWhitespace(stripTags(titleMatch[1])) : undefined;

  let text = html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, "")
    .replace(/<svg[\s\S]*?<\/svg>/gi, "")
    .replace(/<img[^>]*alt=["']([^"']+)["'][^>]*>/gi, "![image]($1)")
    .replace(/<pre[^>]*><code[^>]*>([\s\S]*?)<\/code><\/pre>/gi, (_, body) => {
      return `\n\`\`\`\n${decodeEntities(body)}\n\`\`\`\n`;
    })
    .replace(
      /<code[^>]*>([\s\S]*?)<\/code>/gi,
      (_, body) => `\`${normalizeWhitespace(stripTags(body))}\``,
    )
    .replace(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi, (_, body) => {
      const quote = normalizeWhitespace(stripTags(body));
      return quote
        .split("\n")
        .map((line) => `> ${line}`)
        .join("\n");
    })
    .replace(/<(strong|b)[^>]*>([\s\S]*?)<\/\1>/gi, (_, _tag, body) => {
      return `**${normalizeWhitespace(stripTags(body))}**`;
    })
    .replace(/<(em|i)[^>]*>([\s\S]*?)<\/\1>/gi, (_, _tag, body) => {
      return `*${normalizeWhitespace(stripTags(body))}*`;
    });

  text = text.replace(/<a\s+[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_, href, body) => {
    const label = normalizeWhitespace(stripTags(body));
    if (!label) {
      return href;
    }
    return `[${label}](${href})`;
  });

  text = text.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_, level, body) => {
    const prefix = "#".repeat(Math.max(1, Math.min(6, Number.parseInt(level, 10))));
    const label = normalizeWhitespace(stripTags(body));
    return `\n${prefix} ${label}\n`;
  });

  text = text.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_, body) => {
    const label = normalizeWhitespace(stripTags(body));
    return label ? `\n- ${label}` : "";
  });

  text = text
    .replace(/<(br|hr)\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|section|article|header|footer|table|tr|ul|ol|main|aside|nav)>/gi, "\n")
    .replace(/<(p|div|section|article|header|footer|table|tr|ul|ol|main|aside|nav)[^>]*>/gi, "\n");

  text = stripTags(text);
  text = normalizeWhitespace(text);

  return { text, title };
}

function markdownToText(markdown: string): string {
  let text = markdown;
  text = text.replace(/!\[[^\]]*]\([^)]+\)/g, "");
  text = text.replace(/\[([^\]]+)]\([^)]+\)/g, "$1");
  text = text.replace(/```[\s\S]*?```/g, (block) =>
    block.replace(/```[^\n]*\n?/g, "").replace(/```/g, ""),
  );
  text = text.replace(/`([^`]+)`/g, "$1");
  text = text.replace(/^#{1,6}\s+/gm, "");
  text = text.replace(/^\s*[-*+]\s+/gm, "");
  text = text.replace(/^\s*\d+\.\s+/gm, "");
  return normalizeWhitespace(text);
}

function truncateText(value: string, maxChars: number): { text: string; truncated: boolean } {
  if (value.length <= maxChars) {
    return { text: value, truncated: false };
  }
  return { text: value.slice(0, maxChars), truncated: true };
}

// ---- Tool implementation ----

async function executeWebFetch(
  _toolCallId: string,
  args: Record<string, unknown>,
  ctx: ExtensionToolContext,
): Promise<ExtensionToolResult> {
  const config = parseConfig(ctx.extensionConfig);

  const url = args.url;
  if (typeof url !== "string" || url.trim().length === 0) {
    return {
      content: [
        { type: "text" as const, text: "Error: url parameter is required and must be non-empty" },
      ],
      details: {},
    };
  }

  const urlStr = url.trim();

  // Validate URL protocol
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(urlStr);
  } catch {
    return {
      content: [{ type: "text" as const, text: "Error: Invalid URL format" }],
      details: {},
    };
  }

  if (!["http:", "https:"].includes(parsedUrl.protocol)) {
    return {
      content: [{ type: "text" as const, text: "Error: URL must use http or https protocol" }],
      details: {},
    };
  }

  const hostname = parsedUrl.hostname.toLowerCase();
  if (!(await validateResolvedHostname(hostname))) {
    return {
      content: [
        { type: "text" as const, text: "Error: Request to private/internal hosts is not allowed" },
      ],
      details: {},
    };
  }

  const extractMode = args.extractMode === "text" ? "text" : "markdown";
  const userMaxChars = typeof args.maxChars === "number" ? args.maxChars : config.maxChars;
  const maxChars = Math.min(Math.max(100, userMaxChars), 100000);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), config.timeout);

  let redirectCount = 0;
  let currentUrl = urlStr;

  try {
    while (redirectCount <= config.maxRedirects) {
      let response: Response;

      try {
        response = await fetch(currentUrl, {
          method: "GET",
          headers: {
            Accept: "text/html, text/markdown, */*;q=0.1",
            "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_7_2) AppleWebKit/537.36",
          },
          signal: controller.signal,
          redirect: "manual",
        });
      } catch (fetchError) {
        clearTimeout(timeoutId);

        if (fetchError instanceof Error && fetchError.name === "AbortError") {
          return {
            content: [
              { type: "text" as const, text: `Error: Request timed out after ${config.timeout}ms` },
            ],
            details: {},
          };
        }

        // Try Firecrawl fallback if enabled
        const firecrawlApiKey = resolveFirecrawlApiKey(config);
        if (firecrawlApiKey) {
          const firecrawlResult = await tryFirecrawlFallback(
            urlStr,
            extractMode,
            maxChars,
            config,
            firecrawlApiKey,
          );
          if (firecrawlResult) {
            return firecrawlResult;
          }
        }

        return {
          content: [
            {
              type: "text" as const,
              text: `Error: Fetch failed - ${fetchError instanceof Error ? fetchError.message : String(fetchError)}`,
            },
          ],
          details: {},
        };
      }

      // Handle redirects
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location");
        if (!location) {
          clearTimeout(timeoutId);
          return {
            content: [
              {
                type: "text" as const,
                text: `Error: Redirect without location (status ${response.status})`,
              },
            ],
            details: {},
          };
        }

        redirectCount++;
        if (redirectCount > config.maxRedirects) {
          clearTimeout(timeoutId);
          return {
            content: [
              {
                type: "text" as const,
                text: `Error: Too many redirects (max ${config.maxRedirects})`,
              },
            ],
            details: {},
          };
        }

        try {
          currentUrl = new URL(location, currentUrl).toString();

          const redirectParsed = new URL(currentUrl);
          if (!(await validateResolvedHostname(redirectParsed.hostname.toLowerCase()))) {
            clearTimeout(timeoutId);
            return {
              content: [
                {
                  type: "text" as const,
                  text: "Error: Redirect to private/internal host is not allowed",
                },
              ],
              details: {},
            };
          }
        } catch {
          clearTimeout(timeoutId);
          return {
            content: [{ type: "text" as const, text: "Error: Invalid redirect location" }],
            details: {},
          };
        }

        continue;
      }

      // Check status
      if (!response.ok) {
        clearTimeout(timeoutId);
        return {
          content: [
            {
              type: "text" as const,
              text: `Error: HTTP ${response.status} - ${response.statusText}`,
            },
          ],
          details: { status: response.status, statusText: response.statusText },
        };
      }

      // Read response with size limit
      const contentType = response.headers.get("content-type") || "";
      let bodyText: string;

      try {
        const buffer = await response.arrayBuffer();
        if (buffer.byteLength > config.maxResponseBytes) {
          clearTimeout(timeoutId);
          return {
            content: [
              {
                type: "text" as const,
                text: `Error: Response too large (max ${config.maxResponseBytes} bytes)`,
              },
            ],
            details: { size: buffer.byteLength },
          };
        }
        const decoder = new TextDecoder("utf-8", { fatal: false });
        bodyText = decoder.decode(buffer);
      } catch (readError) {
        clearTimeout(timeoutId);
        return {
          content: [
            {
              type: "text" as const,
              text: `Error: Failed to read response - ${readError instanceof Error ? readError.message : String(readError)}`,
            },
          ],
          details: {},
        };
      }

      clearTimeout(timeoutId);

      // Process content based on content-type
      let text: string;
      let title: string | undefined;

      if (contentType.includes("text/markdown")) {
        // Already markdown
        text = bodyText;
        if (extractMode === "text") {
          text = markdownToText(text);
        }
      } else if (contentType.includes("text/html")) {
        // HTML - convert to markdown/text
        const rendered = htmlToMarkdown(bodyText);
        title = rendered.title;
        text = extractMode === "text" ? markdownToText(rendered.text) : rendered.text;
      } else if (contentType.includes("application/json")) {
        // JSON - format it
        try {
          text = JSON.stringify(JSON.parse(bodyText), null, 2);
        } catch {
          text = bodyText;
        }
      } else {
        // Raw text
        text = bodyText;
      }

      const truncated = truncateText(text, maxChars);
      const suspiciousPatterns = detectSuspiciousPatterns(truncated.text);
      const wrappedText = wrapWebContent(truncated.text, "web_fetch");

      const safeDetails: Record<string, unknown> = {
        url: urlStr,
        finalUrl: currentUrl,
        status: response.status,
        contentType,
        title,
        extractMode,
        extractor: contentType.includes("text/html")
          ? "html"
          : contentType.includes("text/markdown")
            ? "markdown"
            : contentType.includes("application/json")
              ? "json"
              : "raw",
        externalContent: {
          untrusted: true,
          source: "web_fetch",
          wrapped: true,
        },
        truncated: truncated.truncated,
        length: wrappedText.length,
        rawLength: truncated.text.length,
      };
      if (suspiciousPatterns.length > 0) {
        safeDetails.suspiciousPatterns = suspiciousPatterns;
      }

      return {
        content: [{ type: "text" as const, text: wrappedText }],
        details: safeDetails,
      };
    }

    return {
      content: [
        { type: "text" as const, text: `Error: Too many redirects (max ${config.maxRedirects})` },
      ],
      details: {},
    };
  } catch (error) {
    clearTimeout(timeoutId);

    // Try Firecrawl fallback on error
    const firecrawlApiKey = resolveFirecrawlApiKey(config);
    if (firecrawlApiKey) {
      const firecrawlResult = await tryFirecrawlFallback(
        urlStr,
        extractMode,
        maxChars,
        config,
        firecrawlApiKey,
      );
      if (firecrawlResult) {
        return firecrawlResult;
      }
    }

    return {
      content: [
        {
          type: "text" as const,
          text: `Error: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      details: {},
    };
  }
}

async function tryFirecrawlFallback(
  url: string,
  extractMode: "markdown" | "text",
  maxChars: number,
  config: WebFetchConfig,
  apiKey: string,
): Promise<ExtensionToolResult | null> {
  const endpoint = `${config.firecrawlBaseUrl}/v1/scrape`;

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), config.timeout);

    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        url,
        formats: ["markdown"],
        onlyMainContent: true,
      }),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      return null;
    }

    const payload = (await response.json()) as {
      success?: boolean;
      data?: {
        markdown?: string;
        content?: string;
        metadata?: { title?: string };
      };
    };

    if (!payload?.success || !payload.data) {
      return null;
    }

    const rawText =
      typeof payload.data.markdown === "string"
        ? payload.data.markdown
        : typeof payload.data.content === "string"
          ? payload.data.content
          : "";

    const text = extractMode === "text" ? markdownToText(rawText) : rawText;
    const truncated = truncateText(text, maxChars);
    const wrappedText = wrapWebContent(truncated.text, "web_fetch");

    return {
      content: [{ type: "text" as const, text: wrappedText }],
      details: {
        url,
        extractMode,
        extractor: "firecrawl",
        externalContent: {
          untrusted: true,
          source: "web_fetch",
          wrapped: true,
        },
        truncated: truncated.truncated,
        title: payload.data.metadata?.title,
        length: wrappedText.length,
        rawLength: truncated.text.length,
      },
    };
  } catch {
    return null;
  }
}

// ---- Tool definition ----

const webFetchTool: ExtensionToolDefinition = {
  name: "web_fetch",
  label: "Web Fetch",
  description:
    "Fetch a web page and return readable untrusted content as markdown or text. Best for lightweight page access when you need the contents of a specific URL rather than search results.",
  parameters: Type.Object({
    url: Type.String({ minLength: 1, description: "The HTTP(S) URL to fetch" }),
    extractMode: Type.Optional(
      Type.Union([Type.Literal("markdown"), Type.Literal("text")], {
        description: "Extraction mode: 'markdown' (default) or 'text'",
      }),
    ),
    maxChars: Type.Optional(
      Type.Number({
        minimum: 100,
        maximum: 100000,
        description: "Maximum characters to return",
      }),
    ),
  }),
  execute: executeWebFetch,
};

// ---- Extension factory ----

function createWebFetchExtension(_config: Record<string, unknown>): ExtensionManifest {
  return {
    id: "web-fetch",
    version: "1.0.0",
    name: "Web Fetch",
    description:
      "Provides built-in web page fetching for specific URLs with HTTP/HTTPS safety checks, readable HTML extraction, and optional Firecrawl fallback via FIRECRAWL_API_KEY.",
    configSchema: WebFetchConfigSchema,
    capabilities: {
      tools: true,
    },
    register(api) {
      api.registerTool(webFetchTool);
    },
  };
}

// Self-register as a builtin extension
registerBuiltinExtension("web-fetch", createWebFetchExtension);
