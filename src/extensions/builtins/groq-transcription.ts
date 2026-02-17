import { Type } from "@sinclair/typebox";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { ExtensionManifest, ExtensionToolContext, ExtensionToolDefinition } from "../types";
import { registerBuiltinExtension } from "../loader";

const GroqTranscriptionConfigSchema = z.object({
  apiKeyEnv: z.string().default("GROQ_API_KEY"),
  baseUrl: z.string().default("https://api.groq.com/openai/v1"),
  defaultModel: z.string().default("whisper-large-v3-turbo"),
  defaultTemperature: z.number().min(0).max(1).default(0),
  timeoutMs: z.number().int().min(1000).max(120000).default(30000),
});

type GroqTranscriptionConfig = z.infer<typeof GroqTranscriptionConfigSchema>;

type GroqTranscriptionResponse = {
  text?: string;
};

function parseConfig(raw: Record<string, unknown>): GroqTranscriptionConfig {
  const result = GroqTranscriptionConfigSchema.safeParse(raw);
  if (!result.success) {
    return GroqTranscriptionConfigSchema.parse({});
  }
  return result.data;
}

function resolveApiKey(config: GroqTranscriptionConfig): string {
  const key = process.env[config.apiKeyEnv];
  if (!key) {
    throw new Error(
      `Groq API key not found (${config.apiKeyEnv}). Set it in ~/.mozi/.env.var or run: mozi auth set ${config.apiKeyEnv}`,
    );
  }
  return key;
}

async function executeGroqTranscription(
  _toolCallId: string,
  args: Record<string, unknown>,
  ctx: ExtensionToolContext,
): Promise<{ content: Array<{ type: string; text: string }>; details: Record<string, unknown> }> {
  const config = parseConfig(ctx.extensionConfig);

  const filePathValue = args.filePath;
  if (typeof filePathValue !== "string" || filePathValue.trim().length === 0) {
    return {
      content: [
        { type: "text", text: "Error: filePath is required and must be a non-empty string" },
      ],
      details: {},
    };
  }

  const model =
    typeof args.model === "string" && args.model.trim() ? args.model : config.defaultModel;
  const responseFormat =
    typeof args.responseFormat === "string" && args.responseFormat.trim()
      ? args.responseFormat
      : "verbose_json";
  const language =
    typeof args.language === "string" && args.language.trim() ? args.language : undefined;
  const prompt = typeof args.prompt === "string" && args.prompt.trim() ? args.prompt : undefined;
  const temperature =
    typeof args.temperature === "number" && Number.isFinite(args.temperature)
      ? args.temperature
      : config.defaultTemperature;

  let apiKey: string;
  try {
    apiKey = resolveApiKey(config);
  } catch (error) {
    return {
      content: [
        {
          type: "text",
          text: error instanceof Error ? error.message : "Failed to resolve Groq API key",
        },
      ],
      details: {},
    };
  }

  const filePath = path.resolve(filePathValue);
  const fileName = path.basename(filePath);

  try {
    const fileBuffer = await readFile(filePath);
    const file = new File([fileBuffer], fileName, { type: "application/octet-stream" });

    const body = new FormData();
    body.append("file", file);
    body.append("model", model);
    body.append("response_format", responseFormat);
    body.append("temperature", String(temperature));

    if (language) {
      body.append("language", language);
    }
    if (prompt) {
      body.append("prompt", prompt);
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), config.timeoutMs);

    let response: Response;
    try {
      response = await fetch(`${config.baseUrl}/audio/transcriptions`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
        },
        body,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeoutId);
    }

    if (!response.ok) {
      const errorText = await response.text().catch(() => "unknown error");
      return {
        content: [
          {
            type: "text",
            text: `Groq transcription API error (${response.status}): ${errorText}`,
          },
        ],
        details: { statusCode: response.status },
      };
    }

    if (responseFormat === "text") {
      const text = (await response.text()).trim();
      return {
        content: [{ type: "text", text: text || "(empty transcription)" }],
        details: { model, responseFormat, filePath },
      };
    }

    const data = (await response.json()) as GroqTranscriptionResponse & Record<string, unknown>;
    const text = typeof data.text === "string" ? data.text.trim() : "";
    return {
      content: [{ type: "text", text: text || "(empty transcription)" }],
      details: {
        ...data,
        model,
        responseFormat,
        filePath,
      },
    };
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      return {
        content: [
          {
            type: "text",
            text: `Groq transcription timed out after ${config.timeoutMs}ms`,
          },
        ],
        details: {},
      };
    }

    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: "text", text: `Groq transcription failed: ${message}` }],
      details: {},
    };
  }
}

const groqTranscriptionTool: ExtensionToolDefinition = {
  name: "groq_transcribe_audio",
  label: "Groq Audio Transcription",
  description:
    "Transcribe a local audio file using Groq Speech-to-Text (e.g., whisper-large-v3-turbo).",
  parameters: Type.Object({
    filePath: Type.String({
      minLength: 1,
      description: "Absolute or relative path to local audio file",
    }),
    model: Type.Optional(
      Type.String({
        minLength: 1,
        description: "Transcription model (default: whisper-large-v3-turbo)",
      }),
    ),
    temperature: Type.Optional(
      Type.Number({
        minimum: 0,
        maximum: 1,
        description: "Sampling temperature (default: 0)",
      }),
    ),
    responseFormat: Type.Optional(
      Type.Union(
        [
          Type.Literal("json"),
          Type.Literal("verbose_json"),
          Type.Literal("text"),
          Type.Literal("srt"),
          Type.Literal("vtt"),
        ],
        { description: "Output format (default: verbose_json)" },
      ),
    ),
    language: Type.Optional(Type.String({ minLength: 1, description: "ISO-639-1 language code" })),
    prompt: Type.Optional(Type.String({ minLength: 1, description: "Optional context prompt" })),
  }),
  execute: executeGroqTranscription,
};

function createGroqTranscriptionExtension(_config: Record<string, unknown>): ExtensionManifest {
  return {
    id: "groq-transcription",
    version: "1.0.0",
    name: "Groq Transcription",
    description:
      "Provides Groq speech-to-text transcription for local audio files. Requires GROQ_API_KEY (or configured apiKeyEnv).",
    configSchema: GroqTranscriptionConfigSchema,
    capabilities: {
      tools: true,
    },
    register(api) {
      api.registerTool(groqTranscriptionTool);
    },
  };
}

registerBuiltinExtension("groq-transcription", createGroqTranscriptionExtension);
