import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { confirm, input, select } from "@inquirer/prompts";
import pc from "picocolors";
import { resolveTemplatesDir } from "../../agents/templates";
import { getProviderFlow } from "../../configure/provider-flows";
import { getProviderContract } from "../../runtime/providers/contracts";
import { createSecretManager } from "../../storage/secrets/manager";

const DEFAULT_BASE_DIR = path.join(os.homedir(), ".mozi");
const DEFAULT_HOME = path.join(DEFAULT_BASE_DIR, "agents", "main", "home");
const DEFAULT_WORKSPACE = path.join(DEFAULT_BASE_DIR, "agents", "main", "workspace");
const secretManager = createSecretManager();

type ProviderPreset = "openai" | "anthropic" | "google" | "custom";
type ModelApi =
  | "openai-responses"
  | "openai-completions"
  | "anthropic-messages"
  | "google-generative-ai";
type BuiltinProviderPreset = Exclude<ProviderPreset, "custom">;
type Channel = "none" | "discord" | "telegram";

interface InitConfig {
  providerId: string;
  api: ModelApi;
  apiKey: string;
  baseUrl?: string;
  model: string;
  home: string;
  workspace: string;
  channel: Channel;
  channelToken?: string;
}

type ProviderSelection = {
  providerId: string;
  providerLabel: string;
  api: ModelApi;
  baseUrl?: string;
  model: string;
  envVarName: string;
};

function getBuiltinProviderPreset(providerId: BuiltinProviderPreset): {
  label: string;
  defaultModel: string;
  api: ModelApi;
  envVarName: string;
} {
  const flow = getProviderFlow(providerId);
  const contract = getProviderContract(providerId);
  const defaultModel =
    flow?.defaultModelSuggestions?.find((suggestion) => suggestion.alias === "default")?.modelId ??
    flow?.knownModels?.[0]?.id;

  if (!flow?.label || !contract?.canonicalApi || !contract.apiEnvVar || !defaultModel) {
    throw new Error(`Missing built-in provider defaults for ${providerId}`);
  }

  return {
    label: flow.label,
    defaultModel,
    api: contract.canonicalApi as ModelApi,
    envVarName: contract.apiEnvVar,
  };
}

// Home files (agent identity)
const HOME_FILES = [
  "AGENTS.md",
  "SOUL.md",
  "IDENTITY.md",
  "USER.md",
  "MEMORY.md",
  "BOOTSTRAP.md",
  "HEARTBEAT.md",
];

// Workspace files (project rules + tools)
const WORKSPACE_FILES = ["WORK.md", "TOOLS.md"];

function banner() {
  console.log();
  console.log(pc.bold(pc.cyan("🚀 Welcome to Mozi!")));
  console.log();
  console.log("Mozi is your personal AI coding agent runtime.");
  console.log("Let's get you set up in a few simple steps.");
  console.log();
}

function resolvePath(p: string): string {
  if (p.startsWith("~")) {
    return path.join(os.homedir(), p.slice(1));
  }
  return path.resolve(p);
}

function defaultBaseUrlForApi(api: ModelApi): string {
  if (api === "anthropic-messages") {
    return "https://api.anthropic.com/v1";
  }
  if (api === "google-generative-ai") {
    return "https://generativelanguage.googleapis.com/v1beta";
  }
  return "https://api.openai.com/v1";
}

function getBuiltinProviderBaseUrl(providerId: BuiltinProviderPreset): string | undefined {
  return getProviderContract(providerId)?.canonicalBaseUrl;
}

function suggestApiKeyEnvVar(providerId: string): string {
  const normalized = providerId
    .trim()
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase();
  return `${normalized || "CUSTOM"}_API_KEY`;
}

function validateProviderId(inputValue: string): true | string {
  const value = inputValue.trim();
  if (!value) {
    return "Provider ID is required";
  }
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(value)) {
    return "Use lowercase letters, numbers, dot, underscore, or dash";
  }
  return true;
}

function validateEnvVarName(inputValue: string): true | string {
  const value = inputValue.trim();
  if (!value) {
    return "Environment variable name is required";
  }
  if (!/^[A-Z][A-Z0-9_]*$/.test(value)) {
    return "Use format like MY_PROVIDER_API_KEY";
  }
  return true;
}

async function promptProvider(): Promise<ProviderSelection> {
  console.log(pc.bold("\n📦 Model Provider\n"));

  const preset = await select<ProviderPreset>({
    message: "Choose your AI provider:",
    choices: [
      { name: "OpenAI", value: "openai" },
      { name: "Anthropic", value: "anthropic" },
      { name: "Google Gemini", value: "google" },
      { name: "Custom/Proxy", value: "custom" },
    ],
    default: "openai",
  });

  if (preset !== "custom") {
    const provider = getBuiltinProviderPreset(preset);
    const model = await input({
      message: "Model name:",
      default: provider.defaultModel,
      validate: (v: string) => (v.trim().length > 0 ? true : "Model name is required"),
    });
    return {
      providerId: preset,
      providerLabel: provider.label,
      api: provider.api,
      baseUrl: getBuiltinProviderBaseUrl(preset),
      model,
      envVarName: provider.envVarName,
    };
  }

  const providerId = (
    await input({
      message: "Custom provider ID (used in provider/model):",
      default: "custom",
      validate: validateProviderId,
    })
  ).trim();

  const api = await select<ModelApi>({
    message: "Custom provider API protocol:",
    choices: [
      { name: "OpenAI Responses", value: "openai-responses" },
      { name: "OpenAI Completions", value: "openai-completions" },
      { name: "Anthropic Messages", value: "anthropic-messages" },
      { name: "Google Generative AI", value: "google-generative-ai" },
    ],
    default: "openai-responses",
  });

  const baseUrl = await input({
    message: "Base URL:",
    default: defaultBaseUrlForApi(api),
    validate: (v: string) => (v.trim().length > 0 ? true : "Base URL is required"),
  });

  const model = await input({
    message: "Model name:",
    default: "gpt-4o",
    validate: (v: string) => (v.trim().length > 0 ? true : "Model name is required"),
  });

  const envVarName = (
    await input({
      message: "API key environment variable:",
      default: suggestApiKeyEnvVar(providerId),
      validate: validateEnvVarName,
    })
  ).trim();

  return {
    providerId,
    providerLabel: providerId,
    api,
    baseUrl,
    model,
    envVarName,
  };
}

async function promptApiKey(params: {
  providerLabel: string;
  envVarName: string;
}): Promise<string> {
  console.log(pc.bold("\n🔑 API Key\n"));

  const existingKey = process.env[params.envVarName];
  if (existingKey) {
    const useExisting = await confirm({
      message: `Found ${params.envVarName} in environment. Use it?`,
      default: true,
    });
    if (useExisting) {
      return `\${${params.envVarName}}`;
    }
  }

  const apiKey = await input({
    message: `Enter your ${params.providerLabel} API key:`,
    validate: (v: string) => (v.trim().length > 0 ? true : "API key is required"),
  });

  return apiKey;
}

async function promptWorkspace(): Promise<string> {
  console.log(pc.bold("\n📁 Workspace\n"));

  const workspace = await input({
    message: "Where should the agent save work artifacts?",
    default: DEFAULT_WORKSPACE,
  });

  return resolvePath(workspace);
}

async function promptChannel(): Promise<{ channel: Channel; token?: string }> {
  console.log(pc.bold("\n📱 Channels (Optional)\n"));

  const channel = await select<Channel>({
    message: "Would you like to set up a messaging channel?",
    choices: [
      { name: "Skip for now", value: "none" },
      { name: "Discord", value: "discord" },
      { name: "Telegram", value: "telegram" },
    ],
    default: "none",
  });

  if (channel === "none") {
    return { channel };
  }

  const token = await input({
    message: `Enter your ${channel} bot token:`,
    validate: (v: string) => (v.trim().length > 0 ? true : "Token is required"),
  });

  return { channel, token };
}

function buildConfig(config: InitConfig): object {
  const result: Record<string, unknown> = {
    meta: { version: "1.0.2" },
    paths: {
      skills: "~/.mozi/skills",
    },
    models: {
      providers: {
        [config.providerId]: {
          ...(config.baseUrl && { baseUrl: config.baseUrl }),
          apiKey: config.apiKey,
          api: config.api,
          models: [{ id: config.model, name: config.model }],
        },
      },
    },
    logging: {
      level: "info",
    },
    agents: {
      defaults: {
        model: {
          primary: `${config.providerId}/${config.model}`,
        },
      },
      main: {
        name: "Mozi",
        main: true,
        home: config.home,
        workspace: config.workspace,
        skills: [
          "web-search",
          "create-skills",
          "coding-assistant",
          "github-integration",
          "memory-management",
        ],
      },
    },
    skills: {
      dirs: ["~/.mozi/skills"],
      installDir: "~/.mozi/skills",
      allowBundled: [
        "web-search",
        "create-skills",
        "coding-assistant",
        "github-integration",
        "memory-management",
      ],
      install: {
        nodeManager: "pnpm",
      },
    },
    extensions: {
      enabled: true,
      entries: {
        "web-tavily": {
          enabled: false,
          config: {
            apiKeyEnv: "TAVILY_API_KEY",
          },
        },
        "brave-search": {
          enabled: false,
          config: {
            apiKeyEnv: "BRAVE_API_KEY",
          },
        },
      },
    },
    runtime: {
      queue: {
        mode: "steer-backlog",
      },
    },
  };

  if (config.channel !== "none" && config.channelToken) {
    result.channels = {
      [config.channel]: {
        enabled: true,
        ...(config.channel === "discord" && { botToken: config.channelToken }),
        ...(config.channel === "telegram" && { botToken: config.channelToken }),
      },
    };
  }

  return result;
}

async function writeSharedSecret(envKey: string, apiKey: string) {
  if (apiKey.startsWith("${")) {
    return;
  }

  await secretManager.set(envKey, apiKey);
  console.log(pc.dim(`  Stored API key in shared Mozi secret storage (${envKey})`));
}

async function seedFiles(dir: string, files: string[], label: string) {
  const templateDir = resolveTemplatesDir();

  await fs.mkdir(dir, { recursive: true });

  for (const file of files) {
    const destPath = path.join(dir, file);
    try {
      await fs.access(destPath);
      // File exists, skip
    } catch {
      // File doesn't exist, copy from template
      let srcPath: string | null = null;
      if (templateDir) {
        srcPath = path.join(templateDir, file);
      }
      try {
        if (!srcPath) {
          throw new Error("templates_not_found");
        }
        const content = await fs.readFile(srcPath, "utf-8");
        // Strip frontmatter
        const stripped = content.replace(/^---[\s\S]*?---\s*/, "");
        await fs.writeFile(destPath, stripped);
        console.log(pc.dim(`  Created ${label}/${file}`));
      } catch {
        // Template not found, create empty
        await fs.writeFile(destPath, `# ${file}\n`);
        console.log(pc.dim(`  Created ${label}/${file} (empty)`));
      }
    }
  }
}

async function initGitRepo(dir: string) {
  const gitDir = path.join(dir, ".git");
  try {
    await fs.access(gitDir);
    // Already a git repo
    return;
  } catch {
    // Not a git repo, initialize
  }

  try {
    const { execSync } = await import("node:child_process");
    execSync("git init", { cwd: dir, stdio: "ignore" });
    console.log(pc.dim("  Initialized git repository"));
  } catch {
    // Git not available, skip
  }
}

export async function runInitWizard(options: { reset?: boolean; nonInteractive?: boolean }) {
  const baseDir = DEFAULT_BASE_DIR;
  const configPath = path.join(baseDir, "config.jsonc");

  // Check existing config
  try {
    await fs.access(configPath);
    if (!options.reset) {
      console.log(pc.yellow("\n⚠️  Configuration already exists at " + configPath));
      if (options.nonInteractive) {
        console.log(
          pc.red("Non-interactive mode cannot overwrite existing config without --reset."),
        );
        process.exitCode = 1;
        return;
      }
      const overwrite = await confirm({
        message: "Do you want to overwrite it?",
        default: false,
      });
      if (!overwrite) {
        console.log(pc.dim("\nRun with --reset to force overwrite."));
        return;
      }
    }
  } catch {
    // No existing config
  }

  banner();

  // Collect configuration
  const defaultProvider = getBuiltinProviderPreset("openai");
  const provider = options.nonInteractive
    ? {
        providerId: "openai",
        providerLabel: defaultProvider.label,
        api: defaultProvider.api,
        model: defaultProvider.defaultModel,
        envVarName: defaultProvider.envVarName,
      }
    : await promptProvider();
  const apiKey = options.nonInteractive
    ? `\${${provider.envVarName}}`
    : await promptApiKey({
        providerLabel: provider.providerLabel,
        envVarName: provider.envVarName,
      });
  const workspace = options.nonInteractive ? DEFAULT_WORKSPACE : await promptWorkspace();
  const { channel, token: channelToken } = options.nonInteractive
    ? { channel: "none" as const }
    : await promptChannel();

  const config: InitConfig = {
    providerId: provider.providerId,
    api: provider.api,
    apiKey: apiKey.startsWith("${") ? apiKey : `\${${provider.envVarName}}`,
    baseUrl: provider.baseUrl,
    model: provider.model,
    home: DEFAULT_HOME,
    workspace,
    channel,
    channelToken,
  };

  // Create directories
  console.log(pc.bold("\n⚙️  Setting up...\n"));
  await fs.mkdir(baseDir, { recursive: true });

  // Write shared secret storage entry if needed
  if (!apiKey.startsWith("${")) {
    await writeSharedSecret(provider.envVarName, apiKey);
  }

  // Write config
  const configContent = JSON.stringify(buildConfig(config), null, 2);
  await fs.writeFile(configPath, configContent);
  console.log(pc.dim(`  Wrote configuration to ${configPath}`));

  // Seed home files (agent identity)
  console.log(pc.bold("\n🏠 Creating agent home files...\n"));
  await seedFiles(config.home, HOME_FILES, "home");
  await initGitRepo(config.home);

  // Seed workspace files (user tools)
  console.log(pc.bold("\n📁 Creating workspace files...\n"));
  await seedFiles(config.workspace, WORKSPACE_FILES, "workspace");

  // Done
  console.log(pc.bold(pc.green("\n✅ Setup Complete!\n")));
  console.log(`  Configuration: ${pc.cyan(configPath)}`);
  console.log(`  Agent Home: ${pc.cyan(config.home)}`);
  console.log(`  Workspace: ${pc.cyan(config.workspace)}`);
  console.log();
  console.log("Next steps:");
  console.log(`  • Start chatting: ${pc.cyan("mozi chat")}`);
  console.log(`  • Check status: ${pc.cyan("mozi runtime status")}`);
  console.log(`  • View health: ${pc.cyan("mozi health")}`);
  console.log();
  console.log(pc.bold("Happy coding! 🎉"));
  console.log();
}

export async function runSetup(options: { home?: string; workspace?: string }) {
  const home = options.home ? resolvePath(options.home) : DEFAULT_HOME;
  const workspace = options.workspace ? resolvePath(options.workspace) : DEFAULT_WORKSPACE;

  console.log(pc.bold("\n🏠 Setting up agent home...\n"));
  await seedFiles(home, HOME_FILES, "home");
  await initGitRepo(home);

  console.log(pc.bold("\n📁 Setting up workspace...\n"));
  await seedFiles(workspace, WORKSPACE_FILES, "workspace");

  console.log(pc.bold(pc.green("\n✅ Setup complete!\n")));
}
