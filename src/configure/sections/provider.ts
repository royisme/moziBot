import { ModelProviderSchema } from "../../config/schema/models";
import { composeProvider, getProviderContract } from "../../runtime/providers/contracts";
import {
  getProviderFlow,
  PROVIDER_FLOWS,
  supportsDirectConfig,
  supportsExternalEnv,
  supportsSecretStorage,
  type ProviderAuth,
  type ProviderFlow,
} from "../provider-flows";
import type { ConfigureSection, SectionResult, WizardContext } from "../types";

type EditableField = "baseUrl" | "headers" | "auth" | "back";
type ProviderRecord = NonNullable<NonNullable<WizardContext["config"]["models"]>["providers"]>;
type ProviderConfig = ProviderRecord[string];
type SecretSource = "shared-storage" | "direct-config" | "external-env";
type StoredAuth = Exclude<ProviderAuth, "none">;

type KnownModel = NonNullable<ProviderFlow["knownModels"]>[number];

const PROVIDER_AUTH_OPTIONS = [
  { value: "none", label: "none" },
  { value: "api-key", label: "api-key" },
  { value: "aws-sdk", label: "aws-sdk" },
  { value: "oauth", label: "oauth" },
  { value: "token", label: "token" },
] satisfies Array<{ value: ProviderAuth; label: string; hint?: string }>;

function ensureProviders(ctx: WizardContext): ProviderRecord {
  ctx.config.models ??= {};
  ctx.config.models.providers ??= {};
  return ctx.config.models.providers;
}

function ensureAliases(ctx: WizardContext): Record<string, string> {
  ctx.config.models ??= {};
  ctx.config.models.aliases ??= {};
  return ctx.config.models.aliases;
}

function getProviderRecord(ctx: WizardContext): ProviderRecord {
  return ctx.config.models?.providers ?? {};
}

function formatProviderLabel(id: string, config: ProviderConfig): string {
  const composed = composeProvider(id, config);
  const parts = [id];
  if (config.baseUrl) {
    parts.push(`${config.baseUrl} (override)`);
  } else if (composed.baseUrl) {
    parts.push(`${composed.baseUrl} (default)`);
  }
  if (composed.auth) {
    parts.push(composed.auth);
  }
  const modelCount = composed.models?.length ?? 0;
  if (modelCount > 0) {
    parts.push(`${modelCount} model${modelCount === 1 ? "" : "s"}`);
  }
  return parts.join(" · ");
}

function validateProviderConfig(id: string, config: ProviderConfig): ProviderConfig {
  const parsed = ModelProviderSchema.safeParse(config);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => issue.message).join("; ");
    throw new Error(`Invalid provider configuration for ${id}: ${issues}`);
  }
  return parsed.data;
}

function parseHeaders(raw: string): Record<string, string> | undefined {
  const entries = raw
    .split(/\r?\n|,/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((entry) => {
      const separator = entry.indexOf(":");
      if (separator <= 0) {
        throw new Error(`Invalid header entry: ${entry}. Use Header-Name: value.`);
      }
      const key = entry.slice(0, separator).trim();
      const value = entry.slice(separator + 1).trim();
      if (!key || !value) {
        throw new Error(`Invalid header entry: ${entry}. Use Header-Name: value.`);
      }
      return [key, value] as const;
    });

  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function formatHeaders(headers: Record<string, string> | undefined): string {
  return headers
    ? Object.entries(headers)
        .map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`)
        .join(", ")
    : "";
}

function toStoredAuth(auth: ProviderAuth): StoredAuth | undefined {
  return auth === "none" ? undefined : auth;
}

function getContractDefaultProviderConfig(providerId: string): ProviderConfig {
  const contract = getProviderContract(providerId);
  return {
    api: contract?.canonicalApi,
    auth: contract?.auth,
    baseUrl: contract?.canonicalBaseUrl,
    headers: contract?.canonicalHeaders ? { ...contract.canonicalHeaders } : undefined,
    models:
      contract?.catalog?.map((model: KnownModel) => ({
        ...model,
        name: model.label ?? model.id,
        cost: model.cost ? { ...model.cost } : undefined,
      })) ?? [],
  };
}

function stripProviderContractDefaults(providerId: string, config: ProviderConfig): ProviderConfig {
  const defaults = getContractDefaultProviderConfig(providerId);
  const next: ProviderConfig = {};

  if (config.api && config.api !== defaults.api) {
    next.api = config.api;
  }
  if (config.auth && config.auth !== defaults.auth) {
    next.auth = config.auth;
  }
  if (config.baseUrl && config.baseUrl !== defaults.baseUrl) {
    next.baseUrl = config.baseUrl;
  }

  const defaultHeaders = defaults.headers ?? {};
  const configuredHeaders = config.headers ?? {};
  const overrideHeaders = Object.fromEntries(
    Object.entries(configuredHeaders).filter(([key, value]) => defaultHeaders[key] !== value),
  );
  if (Object.keys(overrideHeaders).length > 0) {
    next.headers = overrideHeaders;
  }

  if (config.apiKey !== undefined) {
    next.apiKey = config.apiKey;
  }
  if (config.authHeader !== undefined) {
    next.authHeader = config.authHeader;
  }
  if (config.models && config.models.length > 0) {
    next.models = config.models;
  }
  return next;
}

async function promptProviderSelection(ctx: WizardContext): Promise<ProviderFlow> {
  if (ctx.nonInteractive) {
    const providerId = process.env.MOZI_PROVIDER?.trim();
    if (!providerId) {
      throw new Error("Non-interactive provider configuration requires MOZI_PROVIDER to be set.");
    }
    const flow = getProviderFlow(providerId);
    if (!flow) {
      throw new Error(`Unknown MOZI_PROVIDER value: ${providerId}`);
    }
    return flow;
  }

  return ctx.ui.select({
    message: "Choose a provider",
    options: PROVIDER_FLOWS.map((flow) => ({
      value: flow,
      label: flow.label,
      hint: flow.apiEnvVar ? `${flow.id} · ${flow.apiEnvVar}` : flow.id,
    })),
  });
}

async function promptAuthMethod(ctx: WizardContext, flow: ProviderFlow): Promise<ProviderAuth> {
  if (flow.authMethods.length === 1) {
    return flow.authMethods[0] ?? flow.defaultAuthMethod;
  }
  if (ctx.nonInteractive) {
    const requested = process.env.MOZI_PROVIDER_AUTH?.trim() as ProviderAuth | undefined;
    return requested && flow.authMethods.includes(requested) ? requested : flow.defaultAuthMethod;
  }
  return ctx.ui.select({
    message: `How should ${flow.label} authenticate?`,
    options: flow.authMethods.map((method) => ({
      value: method,
      label: method,
      hint: method === flow.defaultAuthMethod ? "recommended" : undefined,
    })),
  });
}

function availableSecretSources(flow: ProviderFlow, authMethod: ProviderAuth): SecretSource[] {
  if (authMethod === "none") {
    return [];
  }
  const sources: SecretSource[] = [];
  if (supportsSecretStorage(flow)) {
    sources.push("shared-storage");
  }
  if (supportsExternalEnv(flow)) {
    sources.push("external-env");
  }
  if (supportsDirectConfig(flow)) {
    sources.push("direct-config");
  }
  return sources;
}

async function promptSecretSource(
  ctx: WizardContext,
  flow: ProviderFlow,
  authMethod: ProviderAuth,
): Promise<SecretSource | undefined> {
  const sources = availableSecretSources(flow, authMethod);
  if (sources.length === 0) {
    return undefined;
  }
  if (ctx.nonInteractive) {
    const requested = process.env.MOZI_SECRET_SOURCE?.trim() as SecretSource | undefined;
    return requested && sources.includes(requested) ? requested : sources[0];
  }
  return ctx.ui.select({
    message: "Where should credentials come from?",
    options: sources.map((source) => ({
      value: source,
      label: source,
      hint:
        source === "shared-storage"
          ? "Recommended: managed by mozi auth / shared secret storage"
          : source === "external-env"
            ? `Reference ${flow.apiEnvVar} from your shell or service env`
            : "Store the credential directly in config.jsonc",
    })),
  });
}

async function promptBaseUrl(
  ctx: WizardContext,
  message: string,
  currentValue: string | undefined,
  flow?: ProviderFlow,
): Promise<string | undefined> {
  const suggested =
    currentValue ?? getProviderContract(flow?.id ?? "")?.canonicalBaseUrl ?? flow?.defaultBaseUrl;
  const raw = await ctx.ui.text({
    message,
    placeholder: suggested,
    defaultValue: suggested,
  });
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

async function promptCredentialValue(ctx: WizardContext, flow: ProviderFlow): Promise<string> {
  return ctx.ui.password({
    message: `Enter ${flow.label} credential for ${flow.apiEnvVar}`,
    envVar: flow.apiEnvVar,
    validate: (value) => (value.trim() ? undefined : "Credential value is required."),
  });
}

async function configureCredential(
  ctx: WizardContext,
  flow: ProviderFlow,
  config: ProviderConfig,
  authMethod: ProviderAuth,
): Promise<void> {
  const storedAuth = toStoredAuth(authMethod);
  if (storedAuth) {
    config.auth = storedAuth;
  } else {
    delete config.auth;
    delete config.apiKey;
    return;
  }

  if (authMethod === "oauth") {
    throw new Error(
      `${flow.label} OAuth onboarding is no longer managed by mozi. Authenticate with the provider's native CLI instead.`,
    );
  }

  const source = await promptSecretSource(ctx, flow, authMethod);
  if (!source || !flow.apiEnvVar) {
    return;
  }

  if (source === "shared-storage") {
    const credential = await promptCredentialValue(ctx, flow);
    await ctx.secrets.set(flow.apiEnvVar, credential.trim());
    config.apiKey = `\${${flow.apiEnvVar}}`;
    ctx.ui.note(
      `Stored ${flow.apiEnvVar} in shared secret storage and wired config to reference it.`,
      flow.label,
    );
    return;
  }

  if (source === "external-env") {
    config.apiKey = `\${${flow.apiEnvVar}}`;
    ctx.ui.note(
      `Config references ${flow.apiEnvVar}. Export it in your shell or runtime service environment.`,
      flow.label,
    );
    return;
  }

  const credential = await promptCredentialValue(ctx, flow);
  config.apiKey = credential.trim();
  ctx.ui.warn("Stored credential directly in config.jsonc. Prefer shared-storage when possible.");
}

function upsertModel(provider: ProviderConfig, model: KnownModel): void {
  provider.models ??= [];
  const index = provider.models.findIndex((entry) => entry.id === model.id);
  const nextModel = {
    id: model.id,
    name: model.label ?? model.id,
    api: model.api as ProviderConfig["models"] extends Array<infer M>
      ? M extends { api?: infer A }
        ? A
        : never
      : never,
  };
  if (index >= 0) {
    provider.models[index] = { ...provider.models[index], ...nextModel };
    return;
  }
  provider.models.push(nextModel);
}

async function maybeConfigureModels(
  ctx: WizardContext,
  flow: ProviderFlow,
  providerId: string,
  config: ProviderConfig,
): Promise<void> {
  const knownModels = flow.knownModels ?? [];
  if (knownModels.length === 0) {
    return;
  }

  if (ctx.nonInteractive) {
    const requested = process.env.MOZI_MODEL?.trim();
    const selected = knownModels.find((model) => model.id === requested) ?? knownModels[0];
    if (selected) {
      upsertModel(config, selected);
      const aliases = ensureAliases(ctx);
      aliases.default ??= `${providerId}/${selected.id}`;
    }
    return;
  }

  const shouldConfigureModels = await ctx.ui.confirm({
    message: `Pick a default model for ${flow.label} now?`,
    initialValue: true,
  });
  if (!shouldConfigureModels) {
    return;
  }

  const selectedModelId = await ctx.ui.select({
    message: `Select a default model for ${flow.label}`,
    options: knownModels.map((model) => ({
      value: model.id,
      label: model.label ?? model.id,
      hint: model.id,
    })),
  });
  const selected = knownModels.find((model) => model.id === selectedModelId);
  if (!selected) {
    return;
  }

  upsertModel(config, selected);

  const aliases = ensureAliases(ctx);
  const modelRef = `${providerId}/${selected.id}`;
  const makeDefault = await ctx.ui.confirm({
    message: `Set ${selected.label ?? selected.id} as the default model?`,
    initialValue: true,
  });
  if (makeDefault) {
    aliases.default = modelRef;
  }

  if ((flow.defaultModelSuggestions?.length ?? 0) > 0) {
    const shouldAddSuggestedAliases = await ctx.ui.confirm({
      message: "Add suggested aliases for this provider?",
      initialValue: true,
    });
    if (shouldAddSuggestedAliases) {
      for (const suggestion of flow.defaultModelSuggestions ?? []) {
        aliases[suggestion.alias] = `${providerId}/${suggestion.modelId}`;
      }
    }
  }
}

async function addProvider(ctx: WizardContext): Promise<SectionResult> {
  const flow = await promptProviderSelection(ctx);
  const providers = ensureProviders(ctx);
  const nextConfig: ProviderConfig = {};

  const authMethod = await promptAuthMethod(ctx, flow);
  await configureCredential(ctx, flow, nextConfig, authMethod);

  if (!ctx.nonInteractive) {
    const customizeBaseUrl = await ctx.ui.confirm({
      message: `Use canonical base URL for ${flow.label}?`,
      initialValue: true,
    });
    if (!customizeBaseUrl) {
      const nextBaseUrl = await promptBaseUrl(
        ctx,
        `Base URL override for ${flow.label} (leave blank to use canonical default)`,
        undefined,
        flow,
      );
      if (nextBaseUrl) {
        nextConfig.baseUrl = nextBaseUrl;
      }
    }
  }

  await maybeConfigureModels(ctx, flow, flow.id, nextConfig);

  providers[flow.id] = validateProviderConfig(
    flow.id,
    stripProviderContractDefaults(flow.id, nextConfig),
  );
  return { modified: true, message: `Configured provider ${flow.label}.` };
}

async function selectExistingProvider(
  ctx: WizardContext,
  message: string,
): Promise<[string, ProviderConfig] | undefined> {
  const providers = Object.entries(getProviderRecord(ctx));
  if (providers.length === 0) {
    ctx.ui.note("No providers are configured yet.", "Provider");
    return undefined;
  }

  const selectedId = await ctx.ui.select({
    message,
    options: providers.map(([id, config]) => ({
      value: id,
      label: id,
      hint: formatProviderLabel(id, config),
    })),
  });

  return [selectedId, getProviderRecord(ctx)[selectedId]];
}

async function promptEditableField(ctx: WizardContext): Promise<EditableField> {
  return ctx.ui.select<EditableField>({
    message: "Select a field to edit",
    options: [
      {
        value: "baseUrl",
        label: "baseUrl",
        hint: "Set or clear the provider base URL override",
      },
      { value: "headers", label: "headers", hint: "Set custom request headers" },
      { value: "auth", label: "auth mode", hint: "Change provider authentication mode" },
      { value: "back", label: "Back", hint: "Return to provider menu" },
    ],
  });
}

async function editProvider(ctx: WizardContext): Promise<SectionResult> {
  const selection = await selectExistingProvider(ctx, "Select a provider to edit");
  if (!selection) {
    return { modified: false, message: "No provider updated." };
  }

  const [providerId] = selection;
  const flow = getProviderFlow(providerId);
  const providers = ensureProviders(ctx);
  let modified = false;

  while (true) {
    const current = providers[providerId];
    const field = await promptEditableField(ctx);
    if (field === "back") {
      break;
    }

    if (field === "baseUrl") {
      const nextValue = await promptBaseUrl(
        ctx,
        `Base URL override for ${providerId} (leave blank to use canonical default)`,
        current.baseUrl,
        flow,
      );
      if (nextValue) {
        current.baseUrl = nextValue;
      } else {
        delete current.baseUrl;
      }
      modified = true;
    }

    if (field === "headers") {
      const raw = await ctx.ui.text({
        message: `Headers for ${providerId} as Header: value pairs, comma separated (leave blank to clear)`,
        placeholder: formatHeaders(current.headers),
        defaultValue: formatHeaders(current.headers),
      });
      const trimmed = raw.trim();
      current.headers = trimmed ? parseHeaders(trimmed) : undefined;
      if (!current.headers) {
        delete current.headers;
      }
      modified = true;
    }

    if (field === "auth") {
      const nextAuth = flow
        ? await promptAuthMethod(ctx, flow)
        : await ctx.ui.select<ProviderAuth>({
            message: `Authentication mode for ${providerId}`,
            options: PROVIDER_AUTH_OPTIONS,
          });
      await configureCredential(
        ctx,
        flow ?? {
          id: providerId,
          label: providerId,
          auth: nextAuth,
          authMethods: [nextAuth],
          defaultAuthMethod: nextAuth,
          apiEnvVar: "",
          secretSources: [],
        },
        current,
        nextAuth,
      );
      modified = true;
    }

    providers[providerId] = validateProviderConfig(
      providerId,
      stripProviderContractDefaults(providerId, current),
    );
  }

  return modified
    ? { modified: true, message: `Updated provider ${providerId}.` }
    : { modified: false, message: `No changes made to ${providerId}.` };
}

async function removeProvider(ctx: WizardContext): Promise<SectionResult> {
  const selection = await selectExistingProvider(ctx, "Select a provider to remove");
  if (!selection) {
    return { modified: false, message: "No provider removed." };
  }

  const [providerId] = selection;
  const confirmed = await ctx.ui.confirm({
    message: `Remove provider ${providerId}?`,
    initialValue: false,
  });
  if (!confirmed) {
    return { modified: false, message: `Skipped removing ${providerId}.` };
  }

  const providers = ensureProviders(ctx);
  delete providers[providerId];
  return { modified: true, message: `Removed provider ${providerId}.` };
}

async function promptAction(ctx: WizardContext): Promise<"add" | "edit" | "remove" | "back"> {
  return ctx.ui.select({
    message: "Provider configuration",
    options: [
      {
        value: "add",
        label: "Standard provider onboarding",
        hint: "Guided provider, auth, secret, and model setup",
      },
      { value: "edit", label: "Edit provider", hint: "Update an existing provider" },
      { value: "remove", label: "Remove provider", hint: "Delete a configured provider" },
      { value: "back", label: "Back", hint: "Return to the main configure menu" },
    ],
  });
}

export const providerSection: ConfigureSection = {
  name: "provider",
  label: "Providers",
  description: "Integrated provider onboarding for auth, secrets, and default model wiring.",
  order: 10,
  async run(ctx: WizardContext): Promise<SectionResult> {
    if (ctx.nonInteractive) {
      return addProvider(ctx);
    }
    const action = await promptAction(ctx);
    if (action === "back") {
      return { modified: false, message: "Returned to configure menu." };
    }
    if (action === "add") {
      return addProvider(ctx);
    }
    if (action === "edit") {
      return editProvider(ctx);
    }
    return removeProvider(ctx);
  },
};
