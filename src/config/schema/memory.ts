import { z } from "zod";
import { DEFAULT_GOVERNANCE_CONFIG } from "../../memory/governance/config";

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

const MemoryRecallMmrSchema = z
  .object({
    enabled: z.boolean().default(false),
    lambda: z.number().min(0).max(1).default(0.7),
  })
  .strict();

const MemoryRecallTemporalDecaySchema = z
  .object({
    enabled: z.boolean().default(false),
    halfLifeDays: z.number().positive().default(30),
  })
  .strict();

const MemoryRecallMetricsSchema = z
  .object({
    enabled: z.boolean().default(false),
    sampleRate: z.number().min(0).max(1).default(1),
  })
  .strict();

const MemoryRecallSchema = z
  .object({
    mmr: MemoryRecallMmrSchema.optional(),
    temporalDecay: MemoryRecallTemporalDecaySchema.optional(),
    metrics: MemoryRecallMetricsSchema.optional(),
  })
  .strict();

const MemoryEmbeddedProviderSchema = z.enum(["openai", "ollama", "auto"]).default("auto");

const MemoryEmbeddedRemoteSchema = z
  .object({
    baseUrl: z.string().optional(),
    apiKey: z.string().optional(),
    headers: z.record(z.string(), z.string()).optional(),
    timeoutMs: z.number().positive().optional(),
    batchSize: z.number().positive().optional(),
  })
  .strict();

const MemoryEmbeddedVectorSchema = z
  .object({
    enabled: z.boolean().default(true),
    extensionPath: z.string().optional(),
  })
  .strict();

const MemoryEmbeddedStoreSchema = z
  .object({
    path: z.string().optional(),
    vector: MemoryEmbeddedVectorSchema.optional(),
  })
  .strict();

const MemoryEmbeddedChunkingSchema = z
  .object({
    tokens: z.number().positive().default(400),
    overlap: z.number().min(0).default(80),
  })
  .strict();

const MemoryEmbeddedSyncSchema = z
  .object({
    onSessionStart: z.boolean().default(true),
    onSearch: z.boolean().default(true),
    watch: z.boolean().default(true),
    watchDebounceMs: z.number().default(1500),
    intervalMinutes: z.number().default(0),
    forceOnFlush: z.boolean().default(true),
  })
  .strict();

const MemoryEmbeddedHybridSchema = z
  .object({
    enabled: z.boolean().default(true),
    vectorWeight: z.number().min(0).max(1).default(0.7),
    textWeight: z.number().min(0).max(1).default(0.3),
    candidateMultiplier: z.number().min(1).default(4),
  })
  .strict();

const MemoryEmbeddedQuerySchema = z
  .object({
    maxResults: z.number().default(6),
    minScore: z.number().min(0).max(1).default(0.35),
    hybrid: MemoryEmbeddedHybridSchema.optional(),
  })
  .strict();

const MemoryEmbeddedCacheSchema = z
  .object({
    enabled: z.boolean().default(true),
    maxEntries: z.number().positive().optional(),
  })
  .strict();

const MemoryEmbeddedSchema = z
  .object({
    enabled: z.boolean().default(true),
    provider: MemoryEmbeddedProviderSchema.optional(),
    model: z.string().optional(),
    remote: MemoryEmbeddedRemoteSchema.optional(),
    store: MemoryEmbeddedStoreSchema.optional(),
    chunking: MemoryEmbeddedChunkingSchema.optional(),
    sync: MemoryEmbeddedSyncSchema.optional(),
    query: MemoryEmbeddedQuerySchema.optional(),
    cache: MemoryEmbeddedCacheSchema.optional(),
    sources: z.array(z.enum(["memory", "sessions"])).optional(),
    recall: MemoryRecallSchema.optional(),
  })
  .strict();

const MemoryQmdSearchModeSchema = z.enum(["query", "search", "vsearch"]).default("search");

const MemoryQmdSchema = z
  .object({
    command: z.string().default("qmd"),
    searchMode: MemoryQmdSearchModeSchema.optional(),
    includeDefaultMemory: z.boolean().default(true),
    paths: z.array(MemoryPathSchema).optional(),
    update: MemoryUpdateSchema.optional(),
    limits: MemoryLimitsSchema.optional(),
    sessions: MemorySessionsSchema.optional(),
    scope: MemoryScopeSchema.optional(),
    reliability: MemoryReliabilitySchema.optional(),
    recall: MemoryRecallSchema.optional(),
  })
  .strict();

const MemoryPersistenceSchema = z
  .object({
    enabled: z.boolean().default(false),
    onOverflowCompaction: z.boolean().default(true),
    onNewReset: z.boolean().default(true),
    preFlushThresholdPercent: z.number().min(1).max(100).default(80),
    preFlushCooldownMinutes: z.number().min(0).default(0),
    maxMessages: z.number().default(12),
    maxChars: z.number().default(4000),
    timeoutMs: z.number().default(1500),
  })
  .strict();

const MemoryGovernanceSchema = z
  .object({
    enabled: z.boolean().default(DEFAULT_GOVERNANCE_CONFIG.enabled),
    extractOnTurnCompleted: z.boolean().default(DEFAULT_GOVERNANCE_CONFIG.extractOnTurnCompleted),
    extractOnBeforeReset: z.boolean().default(DEFAULT_GOVERNANCE_CONFIG.extractOnBeforeReset),
    extractOnPreCompact: z.boolean().default(DEFAULT_GOVERNANCE_CONFIG.extractOnPreCompact),
    minConfidence: z.number().min(0).max(1).default(DEFAULT_GOVERNANCE_CONFIG.minConfidence),
    promotionScoreThreshold: z.number().default(DEFAULT_GOVERNANCE_CONFIG.promotionScoreThreshold),
    autoPromoteOnUserExplicit: z.boolean().default(DEFAULT_GOVERNANCE_CONFIG.autoPromoteOnUserExplicit),
    recurrenceWindowDays: z.number().positive().default(DEFAULT_GOVERNANCE_CONFIG.recurrenceWindowDays),
    recurrenceCountThreshold: z.number().positive().default(DEFAULT_GOVERNANCE_CONFIG.recurrenceCountThreshold),
    dailyCompilerDebounceMs: z.number().min(0).default(DEFAULT_GOVERNANCE_CONFIG.dailyCompilerDebounceMs),
    maintenanceAutoRun: z.boolean().default(DEFAULT_GOVERNANCE_CONFIG.maintenanceAutoRun),
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
    backend: z.enum(["builtin", "qmd", "embedded"]).default("builtin"),
    citations: z.enum(["auto", "always", "never"]).default("auto"),
    qmd: MemoryQmdSchema.optional(),
    builtin: MemoryBuiltinSchema.optional(),
    embedded: MemoryEmbeddedSchema.optional(),
    persistence: MemoryPersistenceSchema.optional(),
    governance: MemoryGovernanceSchema.optional(),
  })
  .strict();

export type MemoryConfig = z.infer<typeof MemoryConfigSchema>;
