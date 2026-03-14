import { ModelApiSchema, ModelDefinitionSchema } from "../../config/schema/models";
import { composeProvider, type ComposedProvider } from "../../runtime/providers/contracts";
import { getProviderFlow, type ProviderFlow } from "../provider-flows";
import type { ConfigureSection, SectionResult, WizardContext } from "../types";

type ProviderRecord = NonNullable<NonNullable<WizardContext["config"]["models"]>["providers"]>;
type ProviderConfig = ProviderRecord[string];
type ModelDefinition = NonNullable<ProviderConfig["models"]>[number];
type ModelInput = NonNullable<ModelDefinition["input"]>[number];
type KnownModelChoice = Pick<
  ModelDefinition,
  "id" | "name" | "api" | "reasoning" | "input" | "cost" | "contextWindow" | "maxTokens"
>;
type KnownModelLike = KnownModelChoice;

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

function getConfiguredProviders(ctx: WizardContext): Array<[string, ComposedProvider]> {
  return Object.entries(ctx.config.models?.providers ?? {}).map(
    ([id, provider]: [string, ProviderConfig]) => [id, composeProvider(id, provider)],
  );
}

function titleCaseModelId(modelId: string): string {
  return modelId
    .split(/[-_/\s]+/)
    .filter(Boolean)
    .map((part) => (/^\d/.test(part) ? part : part.charAt(0).toUpperCase() + part.slice(1)))
    .join(" ");
}

function validateModelDefinition(providerId: string, model: ModelDefinition): ModelDefinition {
  const parsed = ModelDefinitionSchema.safeParse(model);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => issue.message).join("; ");
    throw new Error(`Invalid model configuration for ${providerId}/${model.id}: ${issues}`);
  }
  return parsed.data;
}

function parsePositiveNumber(raw: string): number | undefined {
  const trimmed = raw.trim();
  if (!trimmed) {
    return undefined;
  }
  const value = Number(trimmed);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error("Value must be a positive number.");
  }
  return value;
}

function sanitizeAlias(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed) {
    return undefined;
  }
  if (trimmed.includes("/")) {
    throw new Error("Alias cannot contain '/'.");
  }
  return trimmed;
}

function getKnownModelDisplayName(model: KnownModelLike): string {
  return model.name;
}

function toKnownModelChoice(model: ModelDefinition): KnownModelChoice {
  return {
    id: model.id,
    name: model.name,
    api: model.api,
    reasoning: model.reasoning,
    input: model.input,
    cost: model.cost,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
  };
}

function normalizeKnownApi(api: string | undefined): ModelDefinition["api"] | undefined {
  if (!api) {
    return undefined;
  }
  const parsed = ModelApiSchema.safeParse(api);
  return parsed.success ? parsed.data : undefined;
}

function upsertModel(provider: ProviderConfig, definition: ModelDefinition): void {
  provider.models ??= [];
  const index = provider.models.findIndex((model) => model.id === definition.id);
  if (index >= 0) {
    provider.models[index] = definition;
  } else {
    provider.models.push(definition);
  }
}

async function selectProvider(ctx: WizardContext): Promise<[string, ComposedProvider] | undefined> {
  const providers = getConfiguredProviders(ctx);
  if (providers.length === 0) {
    ctx.ui.note("No providers are configured yet. Configure a provider first.", "Models");
    return undefined;
  }
  if (ctx.nonInteractive) {
    const providerId = process.env.MOZI_PROVIDER?.trim();
    if (!providerId) {
      throw new Error("Non-interactive model configuration requires MOZI_PROVIDER to be set.");
    }
    return providers.find(([id]) => id === providerId);
  }
  const selectedId = await ctx.ui.select({
    message: "Select a provider for this model",
    options: providers.map(([id, provider]) => ({
      value: id,
      label: getProviderFlow(id)?.label ?? id,
      hint: `${provider.models?.length ?? 0} existing models`,
    })),
  });
  return providers.find(([id]) => id === selectedId);
}

async function promptModelId(
  ctx: WizardContext,
  providerId: string,
  flow?: ProviderFlow,
  provider?: ComposedProvider,
): Promise<string> {
  const knownModels: KnownModelChoice[] = provider?.models?.map(toKnownModelChoice) ?? [];
  if (ctx.nonInteractive) {
    const value = process.env.MOZI_MODEL?.trim();
    if (!value) {
      throw new Error("Non-interactive model configuration requires MOZI_MODEL to be set.");
    }
    return value;
  }
  if (knownModels.length === 0) {
    return ctx.ui.text({
      message: `Enter a model ID for ${flow?.label ?? providerId}`,
      placeholder: "model-name",
      validate: (value) => (value.trim() ? undefined : "Model ID is required."),
    });
  }
  const choice = await ctx.ui.select<string>({
    message: `Choose a model for ${flow?.label ?? providerId}`,
    options: [
      ...knownModels.map((model: KnownModelChoice) => ({
        value: model.id,
        label: getKnownModelDisplayName(model),
        hint: model.id,
      })),
      { value: "__custom__", label: "Custom model", hint: "Enter a model ID manually" },
    ],
  });
  if (choice !== "__custom__") {
    return choice;
  }
  return ctx.ui.text({
    message: `Enter a custom model ID for ${flow?.label ?? providerId}`,
    placeholder: knownModels[0]?.id ?? "model-name",
    validate: (value) => (value.trim() ? undefined : "Model ID is required."),
  });
}

async function promptModelLabel(ctx: WizardContext, modelId: string): Promise<string | undefined> {
  const suggested = titleCaseModelId(modelId);
  if (ctx.nonInteractive) {
    return process.env.MOZI_MODEL_LABEL?.trim() || suggested;
  }
  const raw = await ctx.ui.text({
    message: "Optional display label for this model",
    placeholder: suggested,
    defaultValue: suggested,
  });
  return raw.trim() || suggested;
}

async function promptOptionalPositiveNumber(
  ctx: WizardContext,
  message: string,
  envVar: string,
  defaultValue?: number,
): Promise<number | undefined> {
  if (ctx.nonInteractive) {
    return parsePositiveNumber(process.env[envVar] ?? "") ?? defaultValue;
  }

  if (defaultValue !== undefined) {
    const useDefault = await ctx.ui.confirm({
      message: `${message} Use known value ${defaultValue}?`,
      initialValue: true,
    });
    if (useDefault) {
      return defaultValue;
    }
  }

  const raw = await ctx.ui.text({
    message,
    placeholder: defaultValue !== undefined ? String(defaultValue) : undefined,
    defaultValue: defaultValue !== undefined ? String(defaultValue) : undefined,
    validate: (value) => {
      try {
        parsePositiveNumber(value);
        return undefined;
      } catch (error) {
        return error instanceof Error ? error.message : "Enter a positive number.";
      }
    },
  });
  return parsePositiveNumber(raw);
}

async function promptInputs(
  ctx: WizardContext,
  defaultInputs?: ModelInput[],
): Promise<ModelInput[] | undefined> {
  const options: Array<{ value: ModelInput; label: string; hint: string }> = [
    { value: "text", label: "text", hint: "Text input" },
    { value: "image", label: "image", hint: "Image input" },
    { value: "audio", label: "audio", hint: "Audio input" },
    { value: "video", label: "video", hint: "Video input" },
    { value: "file", label: "file", hint: "File input" },
  ];
  if (ctx.nonInteractive) {
    const raw = process.env.MOZI_MODEL_INPUT_TYPES?.trim();
    if (!raw) {
      return defaultInputs;
    }
    return raw
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean) as ModelInput[];
  }

  if (defaultInputs?.length) {
    const useDefault = await ctx.ui.confirm({
      message: `Use known input types: ${defaultInputs.join(", ")}?`,
      initialValue: true,
    });
    if (useDefault) {
      return defaultInputs;
    }
  }

  const shouldSetInputs = await ctx.ui.confirm({
    message: "Configure supported input types?",
    initialValue: Boolean(defaultInputs?.length),
  });
  if (!shouldSetInputs) {
    return undefined;
  }
  const selected = await ctx.ui.multiselect<ModelInput>({
    message: "Select supported input types",
    options,
    required: true,
  });
  return selected.length > 0 ? selected : undefined;
}

async function promptAlias(
  ctx: WizardContext,
  modelRef: string,
  flow?: ProviderFlow,
): Promise<string | undefined> {
  if (ctx.nonInteractive) {
    const alias = sanitizeAlias(process.env.MOZI_MODEL_ALIAS ?? "");
    if (alias) {
      return alias;
    }
    return process.env.MOZI_MODEL_SET_DEFAULT?.trim().toLowerCase() === "true"
      ? "default"
      : flow?.defaultModelSuggestions?.[0]?.alias;
  }
  const suggested =
    flow?.defaultModelSuggestions?.find((item) => item.modelId === modelRef.split("/")[1])?.alias ??
    "default";
  const shouldSetAlias = await ctx.ui.confirm({
    message: `Assign an alias to ${modelRef}?`,
    initialValue: true,
  });
  if (!shouldSetAlias) {
    return undefined;
  }
  const raw = await ctx.ui.text({
    message: "Enter alias name",
    placeholder: suggested,
    defaultValue: suggested,
    validate: (value) => {
      try {
        sanitizeAlias(value);
        return undefined;
      } catch (error) {
        return error instanceof Error ? error.message : "Alias is invalid.";
      }
    },
  });
  return sanitizeAlias(raw);
}

export const modelSection: ConfigureSection = {
  name: "model",
  label: "Models",
  description: "Add models to configured providers and assign aliases.",
  order: 20,
  async run(ctx: WizardContext): Promise<SectionResult> {
    const selection = await selectProvider(ctx);
    if (!selection) {
      return { modified: false, message: "No providers available for model configuration." };
    }

    const [providerId, provider] = selection;
    const flow = getProviderFlow(providerId);
    const modelId = (await promptModelId(ctx, providerId, flow, provider)).trim();
    const known = provider.models?.find((model: ModelDefinition) => model.id === modelId);

    const model: ModelDefinition = { id: modelId, name: modelId };
    const knownApi = normalizeKnownApi(known?.api);
    if (knownApi) {
      model.api = knownApi;
    }
    if (known?.reasoning !== undefined) {
      model.reasoning = known.reasoning;
    }
    if (known?.cost) {
      model.cost = { ...known.cost };
    }
    const label = await promptModelLabel(
      ctx,
      getKnownModelDisplayName(known ?? { id: modelId, name: modelId }),
    );
    if (label) {
      model.name = label;
    }

    const contextWindow = await promptOptionalPositiveNumber(
      ctx,
      "Optional context window (leave blank to skip)",
      "MOZI_MODEL_CONTEXT_WINDOW",
      known?.contextWindow,
    );
    if (contextWindow !== undefined) {
      model.contextWindow = contextWindow;
    }
    const maxTokens = await promptOptionalPositiveNumber(
      ctx,
      "Optional max tokens (leave blank to skip)",
      "MOZI_MODEL_MAX_TOKENS",
      known?.maxTokens,
    );
    if (maxTokens !== undefined) {
      model.maxTokens = maxTokens;
    }
    const inputs = await promptInputs(ctx, known?.input);
    if (inputs?.length) {
      model.input = inputs;
    }

    const validatedModel = validateModelDefinition(providerId, model);
    const providers = ensureProviders(ctx);
    const existingProvider = providers[providerId] ?? {};
    const nextProvider: ProviderConfig = {
      ...existingProvider,
      models: [...(existingProvider.models ?? [])],
    };
    upsertModel(nextProvider, validatedModel);
    providers[providerId] = nextProvider;

    const modelRef = `${providerId}/${modelId}`;
    const alias = await promptAlias(ctx, modelRef, flow);
    if (alias) {
      ensureAliases(ctx)[alias] = modelRef;
    }

    return {
      modified: true,
      message: alias
        ? `Configured model ${modelRef} and assigned alias ${alias}.`
        : `Configured model ${modelRef}.`,
    };
  },
};
