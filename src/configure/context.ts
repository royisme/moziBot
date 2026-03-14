import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { applyEdits, modify } from "jsonc-parser";
import { applyConfigDefaults, loadConfig, resolveConfigPath } from "../config/loader";
import type { MoziConfig } from "../config/schema";
import { createSecretManager } from "../storage/secrets/manager";
import type { WizardContext } from "./types";
import { createWizardUI } from "./ui";

export interface CreateWizardContextOptions {
  configPath?: string;
  nonInteractive?: boolean;
}

function createDefaultConfigSkeleton(): MoziConfig {
  return applyConfigDefaults({
    $schema: "https://mozi.ai/schema/config.json",
    models: {
      providers: {},
      definitions: {},
      aliases: {},
    },
  }) as MoziConfig;
}

async function atomicWriteFile(filePath: string, content: string): Promise<void> {
  const directory = path.dirname(filePath);
  await fs.mkdir(directory, { recursive: true });
  const tempPath = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`,
  );
  await fs.writeFile(tempPath, content, "utf8");
  await fs.rename(tempPath, filePath);
}

function stringifyConfig(config: MoziConfig): string {
  return `${JSON.stringify(config, null, 2)}\n`;
}

export async function createWizardContext(
  options: CreateWizardContextOptions = {},
): Promise<WizardContext> {
  const configPath = resolveConfigPath(options.configPath);

  let config: MoziConfig;
  try {
    await fs.access(configPath, fsConstants.F_OK);
    const loaded = loadConfig(configPath);
    config =
      loaded.success && loaded.config
        ? loaded.config
        : (() => {
            throw new Error(loaded.errors?.join("\n") ?? `Failed to load config: ${configPath}`);
          })();
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === "ENOENT") {
      config = createDefaultConfigSkeleton();
    } else {
      throw error;
    }
  }

  const persist = async (): Promise<void> => {
    const nextConfig = config;

    try {
      const existing = await fs.readFile(configPath, "utf8");
      const edits = modify(existing, [], nextConfig, {
        formattingOptions: {
          insertSpaces: true,
          tabSize: 2,
        },
      });
      const updated = applyEdits(existing, edits);
      await atomicWriteFile(configPath, updated.endsWith("\n") ? updated : `${updated}\n`);
    } catch (error) {
      const nodeError = error as NodeJS.ErrnoException;
      if (nodeError.code !== "ENOENT") {
        throw error;
      }
      await atomicWriteFile(configPath, stringifyConfig(nextConfig));
    }
  };

  return {
    config,
    configPath,
    secrets: createSecretManager(),
    ui: createWizardUI(Boolean(options.nonInteractive)),
    nonInteractive: Boolean(options.nonInteractive),
    persist,
  };
}
