import { z } from "zod";

export const SkillsConfigSchema = z
  .object({
    // Additional skill directories (supports multiple, for loading)
    dirs: z.array(z.string()).optional(),
    // Skill installation directory (target directory for agent to install new skills)
    installDir: z.string().optional(),
    // Allowed bundled skills
    allowBundled: z.array(z.string()).optional(),
    // Installation preferences
    install: z
      .object({
        nodeManager: z
          .preprocess(
            (value) => (value === "bun" ? "pnpm" : value),
            z.enum(["npm", "pnpm", "yarn"]),
          )
          .optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
