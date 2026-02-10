import { z } from "zod";
import { completeBootstrap, updateHomeFile, HOME_FILES } from "../home";

/**
 * Tool definitions for bootstrap ritual
 */

export const updateIdentitySchema = z.object({
  name: z.string().describe("The agent's chosen name"),
  creature: z.string().describe("What kind of creature/entity the agent is"),
  vibe: z.string().describe("The agent's personality/communication style"),
  emoji: z.string().describe("The agent's signature emoji"),
});

export const updateUserSchema = z.object({
  name: z.string().describe("The user's name"),
  preferredAddress: z.string().optional().describe("How to address the user"),
  timezone: z.string().optional().describe("User's timezone"),
  language: z.string().optional().describe("Preferred language"),
  notes: z.string().optional().describe("Additional notes about the user"),
});

export const updateSoulSchema = z.object({
  additionalTraits: z.string().optional().describe("Additional personality traits to add"),
  boundaries: z.string().optional().describe("Additional boundaries to add"),
  preferences: z.string().optional().describe("User-specific preferences"),
});

function formatIdentityContent(data: z.infer<typeof updateIdentitySchema>): string {
  return `# IDENTITY.md - Who Am I?

- **Name:** ${data.name}
- **Creature:** ${data.creature}
- **Vibe:** ${data.vibe}
- **Emoji:** ${data.emoji}

---

*Identity established during bootstrap ritual.*
`;
}

function formatUserContent(data: z.infer<typeof updateUserSchema>): string {
  const lines = ["# USER.md - User Profile", "", "## Basic Info", `- **Name:** ${data.name}`];

  if (data.preferredAddress) {
    lines.push(`- **Preferred Address:** ${data.preferredAddress}`);
  }
  if (data.timezone) {
    lines.push(`- **Timezone:** ${data.timezone}`);
  }
  if (data.language) {
    lines.push(`- **Language:** ${data.language}`);
  }

  if (data.notes) {
    lines.push("", "## Notes", "", data.notes);
  }

  lines.push("", "---", "", "*Profile created during bootstrap ritual.*");

  return lines.join("\n");
}

export type BootstrapToolResult = {
  success: boolean;
  message: string;
};

export async function handleUpdateIdentity(
  homeDir: string,
  args: z.infer<typeof updateIdentitySchema>,
): Promise<BootstrapToolResult> {
  const content = formatIdentityContent(args);
  await updateHomeFile(homeDir, HOME_FILES.IDENTITY, content);
  return {
    success: true,
    message: `Updated IDENTITY.md with name: ${args.name}, creature: ${args.creature}, vibe: ${args.vibe}, emoji: ${args.emoji}`,
  };
}

export async function handleUpdateUser(
  homeDir: string,
  args: z.infer<typeof updateUserSchema>,
): Promise<BootstrapToolResult> {
  const content = formatUserContent(args);
  await updateHomeFile(homeDir, HOME_FILES.USER, content);
  return {
    success: true,
    message: `Updated USER.md with name: ${args.name}`,
  };
}

export async function handleCompleteBootstrap(homeDir: string): Promise<BootstrapToolResult> {
  await completeBootstrap(homeDir);
  return {
    success: true,
    message:
      "Bootstrap ritual complete! BOOTSTRAP.md has been removed. You are now ready for regular operation.",
  };
}

/**
 * Tool definitions for pi-agent-core
 */
export const bootstrapToolDefinitions = [
  {
    name: "update_identity",
    description:
      "Update the agent's identity file (IDENTITY.md) with name, creature type, vibe, and emoji. Use this during bootstrap ritual.",
    parameters: updateIdentitySchema,
  },
  {
    name: "update_user",
    description:
      "Update the user profile file (USER.md) with user's name, timezone, and preferences. Use this during bootstrap ritual.",
    parameters: updateUserSchema,
  },
  {
    name: "complete_bootstrap",
    description:
      "Complete the bootstrap ritual by removing BOOTSTRAP.md. Call this after updating identity and user files.",
    parameters: z.object({}),
  },
];
