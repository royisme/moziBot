import { z } from "zod";

export const ModelApiSchema = z.enum([
  "openai-responses",
  "openai-completions",
  "openai-codex-responses",
  "anthropic-messages",
  "google-generative-ai",
  "google-gemini-cli",
  "cli-backend",
  "ollama",
]);

export const ModelInputSchema = z.enum(["text", "image", "audio", "video", "file"]);

export const ModelCompatSchema = z
  .object({
    supportsStore: z.boolean().optional(),
    supportsDeveloperRole: z.boolean().optional(),
    supportsReasoningEffort: z.boolean().optional(),
    maxTokensField: z
      .union([z.literal("max_completion_tokens"), z.literal("max_tokens")])
      .optional(),
  })
  .strict()
  .optional();

export const ModelDefinitionSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().optional(),
    api: ModelApiSchema.optional(),
    reasoning: z.boolean().optional(),
    input: z.array(ModelInputSchema).optional(),
    cost: z
      .object({
        input: z.number().optional(),
        output: z.number().optional(),
        cacheRead: z.number().optional(),
        cacheWrite: z.number().optional(),
      })
      .strict()
      .optional(),
    contextWindow: z.number().positive().optional(),
    maxTokens: z.number().positive().optional(),
    headers: z.record(z.string(), z.string()).optional(),
    compat: ModelCompatSchema,
  })
  .strict();

export const ModelProviderSchema = z
  .object({
    baseUrl: z.string().optional(),
    apiKey: z.string().optional(),
    auth: z
      .union([z.literal("api-key"), z.literal("aws-sdk"), z.literal("oauth"), z.literal("token")])
      .optional(),
    api: ModelApiSchema.optional(),
    headers: z.record(z.string(), z.string()).optional(),
    authHeader: z.boolean().optional(),
    models: z.array(ModelDefinitionSchema).optional(),
  })
  .strict();

export const ModelsSchema = z
  .object({
    mode: z.union([z.literal("merge"), z.literal("replace")]).optional(),
    providers: z.record(z.string(), ModelProviderSchema).optional(),
    aliases: z.record(z.string(), z.string()).optional(),
  })
  .strict()
  .superRefine((models, ctx) => {
    const aliases = models.aliases;
    if (!aliases) {
      return;
    }
    for (const alias of Object.keys(aliases)) {
      if (!alias.includes("/")) {
        continue;
      }
      ctx.addIssue({
        code: "custom",
        path: ["aliases", alias],
        message: "Model alias key cannot contain '/'.",
      });
    }
  });
