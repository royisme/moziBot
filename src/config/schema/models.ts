import { z } from "zod";

export const ModelApiSchema = z.enum([
  "openai-responses",
  "openai-completions",
  "anthropic-messages",
  "google-generative-ai",
]);

export const ModelInputSchema = z.enum(["text", "image", "audio", "video", "file"]);

export const ModelDefinitionSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().optional(),
    api: ModelApiSchema.optional(),
    reasoning: z.boolean().optional(),
    input: z.array(ModelInputSchema).optional(),
    contextWindow: z.number().positive().optional(),
    maxTokens: z.number().positive().optional(),
    headers: z.record(z.string(), z.string()).optional(),
  })
  .strict();

export const ModelProviderSchema = z
  .object({
    baseUrl: z.string().optional(),
    apiKey: z.string().optional(),
    api: ModelApiSchema.optional(),
    headers: z.record(z.string(), z.string()).optional(),
    models: z.array(ModelDefinitionSchema).optional(),
  })
  .strict();

export const ModelsSchema = z
  .object({
    providers: z.record(z.string(), ModelProviderSchema).optional(),
  })
  .strict();
