import { z } from "zod";
import { AgentsSchema } from "./agents";
import { ChannelsSchema } from "./channels";
import { ExtensionsConfigSchema } from "./extensions";
import { LoggingSchema } from "./logging";
import { MemoryConfigSchema } from "./memory";
import { MetaSchema } from "./meta";
import { ModelsSchema } from "./models";
import { PathsSchema } from "./paths";
import { RuntimeConfigSchema, RuntimeCronConfigSchema } from "./runtime";
import { SkillsConfigSchema } from "./skills";
import { VoiceConfigSchema } from "./voice";

export const MoziConfigSchema = z
  .object({
    $schema: z.string().optional(),
    $include: z.union([z.string(), z.array(z.string())]).optional(),
    meta: MetaSchema.optional(),
    paths: PathsSchema.optional(),
    models: ModelsSchema.optional(),
    channels: ChannelsSchema.optional(),
    logging: LoggingSchema.optional(),
    agents: AgentsSchema.optional(),
    memory: MemoryConfigSchema.optional(),
    skills: SkillsConfigSchema.optional(),
    voice: VoiceConfigSchema.optional(),
    runtime: RuntimeConfigSchema.optional(),
    // Legacy compatibility: top-level cron block (prefer runtime.cron)
    cron: RuntimeCronConfigSchema.optional(),
    extensions: ExtensionsConfigSchema.optional(),
  })
  .strict();

export type MoziConfig = z.infer<typeof MoziConfigSchema>;
