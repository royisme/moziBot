import { createWizardContext, type CreateWizardContextOptions } from "./context";
import { registerAllSections } from "./registry";
import type { ConfigureSection } from "./types";
import { WizardCancelledError } from "./types";

export interface RunConfigureWizardOptions extends CreateWizardContextOptions {
  sections?: string[];
}

function getRequestedSections(
  _allSections: ConfigureSection[],
  requested: string[] | undefined,
  nonInteractive: boolean,
): string[] | undefined {
  if (requested && requested.length > 0) {
    return requested;
  }

  if (nonInteractive) {
    return ["provider"];
  }

  return undefined;
}

export async function runConfigureWizard(options: RunConfigureWizardOptions = {}): Promise<void> {
  const registry = registerAllSections();
  const sections = registry.list();
  const requestedSections = getRequestedSections(
    sections,
    options.sections,
    Boolean(options.nonInteractive),
  );
  const ctx = await createWizardContext(options);

  if (sections.length === 0) {
    ctx.ui.outro("No configure sections are currently available.");
    return;
  }

  ctx.ui.intro("Mozi configuration wizard");

  try {
    if (requestedSections && requestedSections.length > 0) {
      for (const name of requestedSections) {
        const section = registry.get(name);
        if (!section) {
          throw new Error(
            `Unknown section: ${name}. Available sections: ${registry.names().join(", ") || "(none)"}`,
          );
        }

        const result = await section.run(ctx);
        if (result.message) {
          ctx.ui.note(result.message, section.label);
        }
        if (result.modified) {
          await ctx.persist();
        }
      }
    } else {
      while (true) {
        const choice = await ctx.ui.select<string>({
          message: "What would you like to configure?",
          options: [
            ...sections.map((section) => ({
              value: section.name,
              label: section.label,
              hint: section.description,
            })),
            {
              value: "__done",
              label: "Done",
              hint: "Save and exit",
            },
          ],
        });

        if (choice === "__done") {
          break;
        }

        const section = registry.get(choice);
        if (!section) {
          throw new Error(`Unknown section: ${choice}`);
        }

        const result = await section.run(ctx);
        if (result.message) {
          ctx.ui.note(result.message, section.label);
        }
        if (result.modified) {
          await ctx.persist();
        }
      }
    }

    ctx.ui.outro("Configuration saved.");
  } catch (error) {
    if (error instanceof WizardCancelledError) {
      ctx.ui.warn("Configuration cancelled. Any completed sections were already saved.");
      return;
    }

    throw error;
  }
}
