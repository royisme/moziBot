import { z } from "zod";

export const AgentConfigSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  workspace: z.string(),

  // LLM settings
  model: z.string().optional(), // e.g., "openai/gpt-4o"
  provider: z.string().optional(), // Override provider
  temperature: z.number().optional(),
  maxTokens: z.number().optional(),

  // Prompts
  systemPrompt: z.string().optional(), // Inline
  systemPromptPath: z.string().optional(), // Path to prompt file

  // Context files (automatically loaded from workspace if present, or specified here)
  // Common: SOUL.md, TOOLS.md, USER.md
  contextFiles: z.array(z.string()).optional(),

  // Tools & Skills
  tools: z.array(z.string()).optional(), // Tool names to enable
  skills: z.array(z.string()).optional(), // Skill names to load

  // Sandbox/Container settings
  sandbox: z
    .object({
      mode: z.enum(["off", "apple-vm", "docker"]).optional(),
      workspaceAccess: z.enum(["none", "ro", "rw"]).optional(),
    })
    .optional(),

  // Limits
  contextTokens: z.number().optional(),
  maxTurns: z.number().optional(),
});

export const BindingMatchSchema = z.object({
  channel: z.string().optional(),
  peer: z
    .object({
      id: z.string().optional(),
      kind: z.enum(["dm", "group"]).optional(),
    })
    .optional(),
});

export const BindingSchema = z.object({
  agentId: z.string(),
  match: BindingMatchSchema,
});

export type AgentConfig = z.infer<typeof AgentConfigSchema>;
export type BindingMatch = z.infer<typeof BindingMatchSchema>;
export type Binding = z.infer<typeof BindingSchema>;
