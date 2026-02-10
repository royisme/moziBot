import { z } from "zod";

const MemoryPathSchema = z
  .object({
    name: z.string().optional(),
    path: z.string(),
    pattern: z.string().default("**/*.md"),
  })
  .strict();

const MemoryUpdateSchema = z
  .object({
    interval: z.string().default("5m"),
    debounceMs: z.number().default(15000),
    onBoot: z.boolean().default(true),
    embedInterval: z.string().default("60m"),
  })
  .strict();

const MemoryLimitsSchema = z
  .object({
    maxResults: z.number().default(6),
    maxSnippetChars: z.number().default(700),
    maxInjectedChars: z.number().default(4000),
    timeoutMs: z.number().default(4000),
  })
  .strict();

const MemorySessionsSchema = z
  .object({
    enabled: z.boolean().default(false),
    exportDir: z.string().optional(),
    retentionDays: z.number().optional(),
  })
  .strict();

const MemoryScopeRuleSchema = z
  .object({
    action: z.enum(["allow", "deny"]),
    match: z
      .object({
        channel: z.string().optional(),
        chatType: z.enum(["direct", "group", "channel"]).optional(),
        keyPrefix: z.string().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

const MemoryScopeSchema = z
  .object({
    default: z.enum(["allow", "deny"]).default("deny"),
    rules: z.array(MemoryScopeRuleSchema).optional(),
  })
  .strict();

const MemoryReliabilitySchema = z
  .object({
    maxRetries: z.number().default(2),
    retryBackoffMs: z.number().default(500),
    circuitBreakerThreshold: z.number().default(3),
    circuitOpenMs: z.number().default(30000),
  })
  .strict();

const MemoryQmdSchema = z
  .object({
    command: z.string().default("qmd"),
    includeDefaultMemory: z.boolean().default(true),
    paths: z.array(MemoryPathSchema).optional(),
    update: MemoryUpdateSchema.optional(),
    limits: MemoryLimitsSchema.optional(),
    sessions: MemorySessionsSchema.optional(),
    scope: MemoryScopeSchema.optional(),
    reliability: MemoryReliabilitySchema.optional(),
  })
  .strict();

const MemoryPersistenceSchema = z
  .object({
    enabled: z.boolean().default(false),
    onOverflowCompaction: z.boolean().default(true),
    onNewReset: z.boolean().default(true),
    maxMessages: z.number().default(12),
    maxChars: z.number().default(4000),
    timeoutMs: z.number().default(1500),
  })
  .strict();

const BuiltinSyncSchema = z
  .object({
    onSessionStart: z.boolean().default(true),
    onSearch: z.boolean().default(true),
    watch: z.boolean().default(true),
    watchDebounceMs: z.number().default(1500),
    intervalMinutes: z.number().default(0),
    forceOnFlush: z.boolean().default(true),
  })
  .strict();

const MemoryBuiltinSchema = z
  .object({
    sync: BuiltinSyncSchema.optional(),
  })
  .strict();

export const MemoryConfigSchema = z
  .object({
    backend: z.enum(["builtin", "qmd"]).default("builtin"),
    citations: z.enum(["auto", "always", "never"]).default("auto"),
    qmd: MemoryQmdSchema.optional(),
    builtin: MemoryBuiltinSchema.optional(),
    persistence: MemoryPersistenceSchema.optional(),
  })
  .strict();

export type MemoryConfig = z.infer<typeof MemoryConfigSchema>;
