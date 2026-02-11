import { z } from "zod";
import { SandboxSchema } from "./sandbox";

const ThinkingLevelSchema = z.enum(["off", "minimal", "low", "medium", "high", "xhigh"]);

const ContextPruningSchema = z
  .object({
    enabled: z.boolean().optional(),
    softTrimRatio: z.number().optional(),
    hardClearRatio: z.number().optional(),
    keepLastAssistants: z.number().optional(),
    minPrunableChars: z.number().optional(),
    softTrim: z
      .object({
        maxChars: z.number().optional(),
        headChars: z.number().optional(),
        tailChars: z.number().optional(),
      })
      .strict()
      .optional(),
    hardClearPlaceholder: z.string().optional(),
    protectedTools: z.array(z.string()).optional(),
  })
  .strict();

const OutputRenderSchema = z
  .object({
    showThinking: z.boolean().optional(),
    showToolCalls: z.enum(["off", "summary"]).optional(),
  })
  .strict();

const AgentModelListSchema = z
  .object({
    primary: z.string().min(1).optional(),
    fallbacks: z.array(z.string()).optional(),
  })
  .strict();

export const AgentModelSchema = z.union([
  z.string().min(1),
  AgentModelListSchema,
]);

export const SubagentPolicySchema = z
  .object({
    allow: z.array(z.string()).optional(),
  })
  .strict();

export const HeartbeatSchema = z
  .object({
    enabled: z.boolean().optional(),
    every: z.string().optional(),
    prompt: z.string().optional(),
  })
  .strict();

const LifecycleTemporalSchema = z
  .object({
    enabled: z.boolean().optional(),
    activeWindowHours: z.number().int().positive().optional(),
    dayBoundaryRollover: z.boolean().optional(),
  })
  .strict();

const LifecycleSemanticSchema = z
  .object({
    enabled: z.boolean().optional(),
    threshold: z.number().min(0).max(1).optional(),
    debounceSeconds: z.number().int().nonnegative().optional(),
    reversible: z.boolean().optional(),
  })
  .strict();

const LifecycleControlModelSchema = z
  .object({
    model: z.string().min(1).optional(),
    fallback: z.array(z.string().min(1)).optional(),
  })
  .strict();

const LifecycleSchema = z
  .object({
    temporal: LifecycleTemporalSchema.optional(),
    semantic: LifecycleSemanticSchema.optional(),
    control: LifecycleControlModelSchema.optional(),
  })
  .strict();

export const ExecPolicySchema = z
  .object({
    allowlist: z.array(z.string()).optional(),
    allowedSecrets: z.array(z.string()).optional(),
  })
  .strict();

export const AgentEntrySchema = z
  .object({
    name: z.string().optional(),
    main: z.boolean().optional(),
    home: z.string().optional(),
    workspace: z.string().optional(),
    systemPrompt: z.string().optional(),
    model: AgentModelSchema.optional(),
    imageModel: AgentModelSchema.optional(),
    skills: z.array(z.string()).optional(),
    tools: z.array(z.string()).optional(),
    subagents: SubagentPolicySchema.optional(),
    sandbox: SandboxSchema.optional(),
    exec: ExecPolicySchema.optional(),
    heartbeat: HeartbeatSchema.optional(),
    lifecycle: LifecycleSchema.optional(),
    thinking: ThinkingLevelSchema.optional(),
    output: OutputRenderSchema.optional(),
    contextPruning: ContextPruningSchema.optional(),
  })
  .strict();

export const AgentsSchema = z
  .object({
    defaults: z
      .object({
        model: AgentModelSchema.optional(),
        imageModel: AgentModelSchema.optional(),
        tools: z.array(z.string()).optional(),
        sandbox: SandboxSchema.optional(),
        exec: ExecPolicySchema.optional(),
        heartbeat: HeartbeatSchema.optional(),
        lifecycle: LifecycleSchema.optional(),
        thinking: ThinkingLevelSchema.optional(),
        output: OutputRenderSchema.optional(),
        contextPruning: ContextPruningSchema.optional(),
        contextTokens: z.number().optional(),
      })
      .strict()
      .optional(),
  })
  .catchall(AgentEntrySchema)
  .superRefine((agents, ctx) => {
    const mainAgents = Object.entries(agents).filter(([id, entry]) => {
      if (id === "defaults") {
        return false;
      }
      const agentEntry = entry as z.infer<typeof AgentEntrySchema>;
      return agentEntry.main === true;
    });

    if (mainAgents.length <= 1) {
      return;
    }

    for (const [id] of mainAgents) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [id, "main"],
        message: "Only one agent can set main=true.",
      });
    }
  });
