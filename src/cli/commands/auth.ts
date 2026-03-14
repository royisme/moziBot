import { input } from "@inquirer/prompts";
import pc from "picocolors";
import { loginOpenAICodexOAuth } from "../../commands/codex-oauth";
import { loadConfig, resolveConfigPath } from "../../config/loader";
import {
  getProviderFlow,
  listStandardProviderTargets,
  supportsDirectConfig,
  supportsExternalEnv,
  supportsSecretStorage,
  type ProviderFlow,
} from "../../configure/provider-flows";
import { createSecretManager } from "../../storage/secrets/manager";

const secretManager = createSecretManager();

type AuthOptions = {
  config?: string;
  value?: string;
  remote?: boolean;
};

type ResolvedTarget = {
  envVar: string;
  provider?: ProviderFlow;
};

const STANDARD_PROVIDER_TARGETS = listStandardProviderTargets();

function isExplicitEnvVar(target: string): boolean {
  return /^[A-Z][A-Z0-9_]*$/.test(target.trim());
}

function resolveTarget(target: string): ResolvedTarget {
  const provider = getProviderFlow(target.trim().toLowerCase());
  if (provider && provider.apiEnvVar.trim()) {
    return { envVar: provider.apiEnvVar, provider };
  }

  const trimmed = target.trim();
  if (isExplicitEnvVar(trimmed)) {
    return { envVar: trimmed };
  }

  const knownTargets = STANDARD_PROVIDER_TARGETS.map((entry) => entry.id).join(", ");
  throw new Error(
    `Unknown target "${target}". Use a standard provider (${knownTargets}) or an ENV var like OPENAI_API_KEY.`,
  );
}

function renderStatus(inProcess: boolean, inStorage: boolean): string {
  if (inProcess && inStorage) {
    return pc.green("set (env + shared storage)");
  }
  if (inProcess) {
    return pc.green("set (env)");
  }
  if (inStorage) {
    return pc.green("set (shared storage)");
  }
  return pc.red("not set");
}

function formatTargetLabel(target: ProviderFlow): string {
  return `${target.id.padEnd(13)} (${pc.cyan(target.apiEnvVar)})`;
}

function describeProviderMethods(provider: ProviderFlow): string {
  const authMethods = provider.authMethods.join(", ");
  const secretSources = [
    supportsSecretStorage(provider) ? "shared storage" : undefined,
    supportsExternalEnv(provider) ? "process env" : undefined,
    supportsDirectConfig(provider) ? "direct config" : undefined,
  ]
    .filter(Boolean)
    .join(", ");
  return `auth: ${authMethods}; secret sources: ${secretSources}`;
}

function resolveBaseDirFromConfig(configPath?: string): string | undefined {
  if (!configPath) {
    return undefined;
  }
  const result = loadConfig(resolveConfigPath(configPath));
  return result.config?.paths?.baseDir;
}

export async function authLogin(target: string, options: AuthOptions): Promise<void> {
  const resolved = resolveTarget(target);
  if (!resolved.provider) {
    throw new Error(
      `Interactive provider auth requires a standard provider target, got ${target}.`,
    );
  }

  if (resolved.provider.id === "openai-codex") {
    const credentials = await loginOpenAICodexOAuth({
      baseDir: resolveBaseDirFromConfig(options.config),
      isRemote: Boolean(options.remote),
    });
    if (!credentials) {
      return;
    }
    console.log();
    console.log(pc.green(`Found Codex CLI credentials for ${resolved.provider.label}.`));
    console.log(pc.dim("mozi reads Codex auth from the native Codex CLI credential store."));
    return;
  }

  throw new Error(
    `Provider ${resolved.provider.label} does not expose a managed OAuth login flow in mozi.`,
  );
}

export async function authSet(target: string, options: AuthOptions): Promise<void> {
  const resolved = resolveTarget(target);
  const secret =
    options.value ??
    (await input({
      message: `Enter value for ${resolved.envVar}:`,
      validate: (value) => (value.trim().length > 0 ? true : "Value is required"),
    }));

  const normalized = secret.trim();
  if (normalized.includes("\n") || normalized.includes("\r")) {
    console.error(pc.red("Value must be a single line."));
    process.exit(1);
  }

  await secretManager.set(resolved.envVar, normalized);

  if (resolved.provider) {
    console.log(pc.green(`Saved credential for ${resolved.provider.label} (${resolved.envVar}).`));
    console.log(pc.dim(describeProviderMethods(resolved.provider)));
  } else {
    console.log(pc.green(`Saved secret ${resolved.envVar}.`));
  }
  console.log(pc.dim("Stored in shared Mozi secret storage (~/.mozi/.env)."));
  console.log(pc.dim("Restart mozi runtime if it is already running."));
}

export async function authList(_options: { config?: string }): Promise<void> {
  console.log(pc.bold("Standard provider credentials"));

  for (const target of STANDARD_PROVIDER_TARGETS) {
    const inProcess = Boolean(process.env[target.apiEnvVar]?.trim());
    const inStorage = await secretManager.has(target.apiEnvVar);
    console.log(`  ${formatTargetLabel(target)}: ${renderStatus(inProcess, inStorage)}`);
    console.log(`    ${pc.dim(describeProviderMethods(target))}`);
  }

  const knownProviderEnvVars = new Set(STANDARD_PROVIDER_TARGETS.map((target) => target.apiEnvVar));
  const customSecrets = (await secretManager.list()).filter(
    (key) => !knownProviderEnvVars.has(key),
  );

  console.log("");
  console.log(pc.bold("Custom secrets"));
  if (customSecrets.length === 0) {
    console.log(`  ${pc.dim("none")}`);
  } else {
    for (const key of customSecrets) {
      const inProcess = Boolean(process.env[key]?.trim());
      const inStorage = true;
      console.log(`  ${key}: ${renderStatus(inProcess, inStorage)}`);
    }
  }

  console.log("");
  console.log(pc.dim("Use `mozi auth set <provider>` for standard providers."));
  console.log(
    pc.dim("Use `mozi auth set <ENV_VAR>` for custom secrets managed through the same storage."),
  );
}

export async function authRemove(target: string, _options: { config?: string }): Promise<void> {
  const resolved = resolveTarget(target);
  const existed = await secretManager.has(resolved.envVar);
  if (!existed) {
    console.log(pc.yellow(`${resolved.envVar} is not stored in shared secret storage.`));
    return;
  }

  await secretManager.delete(resolved.envVar);
  if (resolved.provider) {
    console.log(
      pc.green(`Removed credential for ${resolved.provider.label} (${resolved.envVar}).`),
    );
  } else {
    console.log(pc.green(`Removed secret ${resolved.envVar}.`));
  }
}
