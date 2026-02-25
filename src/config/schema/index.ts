import { z } from "zod";
import { AgentsSchema } from "./agents";
import { BrowserConfigSchema } from "./browser";
import { ChannelsSchema } from "./channels";
import { ExtensionsConfigSchema } from "./extensions";
import { LoggingSchema } from "./logging";
import { MemoryConfigSchema } from "./memory";
import { MetaSchema } from "./meta";
import { ModelsSchema } from "./models";
import { PathsSchema } from "./paths";
import { RuntimeConfigSchema, RuntimeCronConfigSchema } from "./runtime";
import { SessionConfigSchema } from "./session";
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
    browser: BrowserConfigSchema.optional(),
    agents: AgentsSchema.optional(),
    session: SessionConfigSchema.optional(),
    memory: MemoryConfigSchema.optional(),
    skills: SkillsConfigSchema.optional(),
    voice: VoiceConfigSchema.optional(),
    runtime: RuntimeConfigSchema.optional(),
    // Legacy compatibility: top-level cron block (prefer runtime.cron)
    cron: RuntimeCronConfigSchema.optional(),
    extensions: ExtensionsConfigSchema.optional(),
  })
  .strict()
  .superRefine((config, ctx) => {
    const browser = config.browser;
    if (!browser) {
      return;
    }
    const profiles = browser.profiles ?? {};
    const hasExtensionProfile = Object.values(profiles).some(
      (profile) => profile?.driver === "extension",
    );
    if (!browser.relay?.enabled || !hasExtensionProfile) {
      return;
    }
    const token = browser.relay?.authToken?.trim();
    if (!token) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["browser", "relay", "authToken"],
        message: "browser.relay.authToken is required when browser relay is enabled",
      });
    }
  });

export type MoziConfig = z.infer<typeof MoziConfigSchema>;
