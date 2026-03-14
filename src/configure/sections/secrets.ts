import type { MoziConfig } from "../../config/schema";
import { findProvidersByEnvVar, getProviderContract } from "../../runtime/providers/contracts";
import type { ConfigureSection, Diagnostic, SectionResult, WizardContext } from "../types";

type SecretAction = "add" | "update" | "delete" | "validate" | "back";
type ValidationStatus = "valid" | "invalid" | "skipped";

type SecretSummary = {
  key: string;
  maskedValue: string;
  providers: string[];
  references: string[];
};

type ValidationResult = {
  key: string;
  provider: string;
  status: ValidationStatus;
  message: string;
};

const SECRET_PATTERN = /\$\{([^}]+)\}/g;

function maskSecret(value: string): string {
  if (value.length === 0) {
    return "...";
  }

  if (value.length < 5) {
    return "****";
  }

  if (value.length >= 10) {
    return `${value.slice(0, 3)}...${value.slice(-4)}`;
  }

  return `${value.slice(0, 2)}...${value.slice(-2)}`;
}

function getLinkedProviders(key: string): string[] {
  return findProvidersByEnvVar(key);
}

function collectSecretReferences(
  input: unknown,
  knownKeys: Set<string>,
  currentPath = "config",
  references = new Map<string, Set<string>>(),
): Map<string, Set<string>> {
  if (typeof input === "string") {
    for (const match of input.matchAll(SECRET_PATTERN)) {
      const key = match[1];
      if (knownKeys.has(key)) {
        const value = references.get(key) ?? new Set<string>();
        value.add(currentPath);
        references.set(key, value);
      }
    }
    return references;
  }

  if (Array.isArray(input)) {
    input.forEach((value, index) => {
      collectSecretReferences(value, knownKeys, `${currentPath}[${index}]`, references);
    });
    return references;
  }

  if (input && typeof input === "object") {
    for (const [key, value] of Object.entries(input)) {
      collectSecretReferences(value, knownKeys, `${currentPath}.${key}`, references);
    }
  }

  return references;
}

function defaultBaseUrlFor(providerId: string): string | undefined {
  return getProviderContract(providerId)?.canonicalBaseUrl;
}

function getValidationUrl(config: MoziConfig, providerId: string, key: string): string | undefined {
  const configuredBaseUrl = config.models?.providers?.[providerId]?.baseUrl;
  const baseUrl = configuredBaseUrl ?? defaultBaseUrlFor(providerId);
  const endpointSuffix = VALIDATION_ENDPOINT_SUFFIX[providerId];
  if (!baseUrl || !endpointSuffix) {
    return undefined;
  }

  const normalizedBaseUrl = baseUrl.replace(/\/$/, "");
  if (providerId === "google") {
    const url = new URL(`${normalizedBaseUrl}${endpointSuffix}`);
    url.searchParams.set("key", key);
    return url.toString();
  }

  return `${normalizedBaseUrl}${endpointSuffix}`;
}

function redactValidationUrl(url: string): string {
  const redactedUrl = new URL(url);
  if (redactedUrl.searchParams.has("key")) {
    redactedUrl.searchParams.set("key", "[REDACTED]");
  }
  return redactedUrl.toString();
}

function buildValidationHeaders(
  providerId: string,
  key: string,
): Record<string, string> | undefined {
  switch (providerId) {
    case "openai":
    case "openrouter":
    case "xai":
    case "mistral":
    case "together":
    case "huggingface":
    case "minimax":
    case "moonshot":
    case "kimi-coding":
    case "litellm":
    case "opencode":
    case "kilocode":
    case "modelstudio":
    case "venice":
    case "byteplus":
    case "volcengine":
    case "vercel-ai-gateway":
    case "qianfan":
    case "zai":
      return { Authorization: `Bearer ${key}` };
    case "anthropic":
    case "synthetic":
    case "xiaomi":
      return { "x-api-key": key };
    case "cloudflare-ai-gateway":
      return { "cf-aig-authorization": `Bearer ${key}` };
    default:
      return undefined;
  }
}

async function listSecrets(ctx: WizardContext): Promise<SecretSummary[]> {
  const keys = await ctx.secrets.list();
  const references = collectSecretReferences(ctx.config, new Set(keys));
  const items = await Promise.all(
    keys.map(async (key) => {
      const value = await ctx.secrets.get(key);
      return {
        key,
        maskedValue: value === undefined ? "(unavailable)" : maskSecret(value),
        providers: getLinkedProviders(key),
        references: [...(references.get(key) ?? new Set<string>())].toSorted((left, right) =>
          left.localeCompare(right),
        ),
      } satisfies SecretSummary;
    }),
  );

  return items.toSorted((left, right) => left.key.localeCompare(right.key));
}

function formatSecretsNote(items: SecretSummary[]): string {
  if (items.length === 0) {
    return "No secrets configured yet.";
  }

  return items
    .map((item) => {
      const linkedProviders = item.providers.length > 0 ? item.providers.join(", ") : "none";
      const references = item.references.length > 0 ? item.references.join(", ") : "none";
      return `${item.key} = ${item.maskedValue}\n  providers: ${linkedProviders}\n  references: ${references}`;
    })
    .join("\n\n");
}

async function promptSecretKey(ctx: WizardContext, existingKeys: string[] = []): Promise<string> {
  return ctx.ui.text({
    message: "Enter secret key name",
    placeholder: "OPENAI_API_KEY",
    validate: (value) => {
      const trimmed = value.trim();
      if (trimmed.length === 0) {
        return "Secret key name is required.";
      }
      if (!/^[A-Z][A-Z0-9_]*$/.test(trimmed)) {
        return "Use uppercase letters, numbers, and underscores only.";
      }
      if (existingKeys.includes(trimmed)) {
        return "A secret with this key already exists.";
      }
      return undefined;
    },
  });
}

async function promptSecretValue(ctx: WizardContext, key: string): Promise<string> {
  return ctx.ui.password({
    message: `Enter secret value for ${key}`,
    envVar: key,
    validate: (value) => (value.trim().length > 0 ? undefined : "Secret value is required."),
  });
}

async function selectExistingSecret(
  ctx: WizardContext,
  message: string,
): Promise<SecretSummary | undefined> {
  const items = await listSecrets(ctx);
  if (items.length === 0) {
    ctx.ui.note("No secrets are configured yet.", "Secrets");
    return undefined;
  }

  const selectedKey = await ctx.ui.select({
    message,
    options: items.map((item) => ({
      value: item.key,
      label: item.key,
      hint: `${item.maskedValue} · providers: ${item.providers.join(", ") || "none"}`,
    })),
  });

  return items.find((item) => item.key === selectedKey);
}

async function addSecret(ctx: WizardContext): Promise<SectionResult> {
  const existingKeys = await ctx.secrets.list();
  const key = (await promptSecretKey(ctx, existingKeys)).trim();
  const value = await promptSecretValue(ctx, key);
  await ctx.secrets.set(key, value);
  return { modified: true, message: `Added secret ${key}.` };
}

async function updateSecret(ctx: WizardContext): Promise<SectionResult> {
  const selected = await selectExistingSecret(ctx, "Select a secret to update");
  if (!selected) {
    return { modified: false, message: "No secret updated." };
  }

  const value = await promptSecretValue(ctx, selected.key);
  await ctx.secrets.set(selected.key, value);
  return { modified: true, message: `Updated secret ${selected.key}.` };
}

async function deleteSecret(ctx: WizardContext): Promise<SectionResult> {
  const selected = await selectExistingSecret(ctx, "Select a secret to delete");
  if (!selected) {
    return { modified: false, message: "No secret deleted." };
  }

  const confirmed = await ctx.ui.confirm({
    message: `Delete secret ${selected.key}?`,
    initialValue: false,
  });
  if (!confirmed) {
    return { modified: false, message: `Skipped deleting ${selected.key}.` };
  }

  await ctx.secrets.delete(selected.key);
  return { modified: true, message: `Deleted secret ${selected.key}.` };
}

async function validateProviderSecret(
  ctx: WizardContext,
  key: string,
  providerId: string,
): Promise<ValidationResult> {
  const secretValue = providerId === "ollama" ? "" : await ctx.secrets.get(key);
  if (providerId !== "ollama" && !secretValue) {
    return {
      key,
      provider: providerId,
      status: "invalid",
      message: "Secret value is missing.",
    };
  }

  const url = getValidationUrl(ctx.config, providerId, secretValue ?? "");
  if (!url) {
    return {
      key,
      provider: providerId,
      status: "skipped",
      message: "No validation endpoint is defined for this provider.",
    };
  }

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: buildValidationHeaders(providerId, secretValue ?? ""),
    });

    if (response.ok) {
      return {
        key,
        provider: providerId,
        status: "valid",
        message: `Validated via ${redactValidationUrl(url)}.`,
      };
    }

    let details = `HTTP ${response.status}`;
    try {
      const body = (await response.text()).trim();
      if (body) {
        details = `${details}: ${body.slice(0, 200)}`;
      }
    } catch {
      // ignore response body read failures
    }

    return {
      key,
      provider: providerId,
      status: "invalid",
      message: details,
    };
  } catch (error) {
    return {
      key,
      provider: providerId,
      status: "invalid",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

const VALIDATION_ENDPOINT_SUFFIX: Partial<Record<string, string>> = {
  google: "/v1beta/models",
  openrouter: "/api/v1/models",
  "vercel-ai-gateway": "/api/v1/models",
  ollama: "/api/tags",
  qianfan: "/v2/models",
  openai: "/v1/models",
  anthropic: "/v1/models",
  xai: "/v1/models",
  mistral: "/v1/models",
  together: "/v1/models",
  huggingface: "/v1/models",
  minimax: "/v1/models",
  moonshot: "/v1/models",
  litellm: "/v1/models",
  opencode: "/v1/models",
  kilocode: "/v1/models",
  modelstudio: "/v1/models",
  venice: "/v1/models",
  synthetic: "/v1/models",
  byteplus: "/v1/models",
  volcengine: "/v1/models",
};

async function validateSecrets(ctx: WizardContext): Promise<SectionResult> {
  const items = await listSecrets(ctx);
  const linkedItems = items.filter((item) => item.providers.length > 0);

  if (linkedItems.length === 0) {
    ctx.ui.note("No provider-linked secrets found to validate.", "Secrets");
    return { modified: false, message: "No secrets validated." };
  }

  const spinner = ctx.ui.spinner();
  spinner.start("Validating secrets...");

  const results: ValidationResult[] = [];
  for (const item of linkedItems) {
    for (const providerId of item.providers) {
      results.push(await validateProviderSecret(ctx, item.key, providerId));
    }
  }

  spinner.stop("Secret validation finished.");

  const summary = results
    .map((result) => `${result.key} → ${result.provider}: ${result.status} (${result.message})`)
    .join("\n");
  ctx.ui.note(summary, "Secret validation");

  return { modified: false, message: "Validated provider-linked secrets." };
}

async function promptAction(ctx: WizardContext): Promise<SecretAction> {
  return ctx.ui.select({
    message: "Secrets",
    options: [
      { value: "add", label: "Add secret", hint: "Store a new secret" },
      { value: "update", label: "Update secret", hint: "Replace an existing secret value" },
      { value: "delete", label: "Delete secret", hint: "Remove a stored secret" },
      { value: "validate", label: "Validate secrets", hint: "Check provider-linked secrets" },
      { value: "back", label: "Back", hint: "Return to the main configure menu" },
    ],
  });
}

export const secretsSection: ConfigureSection = {
  name: "secrets",
  label: "Secrets",
  description:
    "Manage custom secrets and trace where configuration references them. Use `mozi auth` for standard provider credentials.",
  order: 30,
  async run(ctx: WizardContext): Promise<SectionResult> {
    if (ctx.nonInteractive) {
      return validateSecrets(ctx);
    }

    let modified = false;

    while (true) {
      const items = await listSecrets(ctx);
      ctx.ui.note(formatSecretsNote(items), "Secrets");

      const action = await promptAction(ctx);
      if (action === "back") {
        return {
          modified,
          message: modified
            ? "Updated secrets and returned to configure menu."
            : "Returned to configure menu.",
        };
      }
      if (action === "add") {
        const result = await addSecret(ctx);
        modified ||= result.modified;
        continue;
      }
      if (action === "update") {
        const result = await updateSecret(ctx);
        modified ||= result.modified;
        continue;
      }
      if (action === "delete") {
        const result = await deleteSecret(ctx);
        modified ||= result.modified;
        continue;
      }
      if (action === "validate") {
        await validateSecrets(ctx);
      }
    }
  },
  async validate(ctx: WizardContext): Promise<Diagnostic[]> {
    const items = await listSecrets(ctx);
    const diagnostics: Diagnostic[] = [];

    for (const item of items) {
      if (item.providers.length > 0 && item.references.length === 0) {
        diagnostics.push({
          level: "info",
          message: `Secret ${item.key} is linked to provider ${item.providers.join(", ")} but is not referenced in config.`,
        });
      }
      if (item.references.length > 0) {
        diagnostics.push({
          level: "info",
          message: `Secret ${item.key} is referenced by ${item.references.join(", ")}.`,
        });
      }
    }

    if (diagnostics.length === 0) {
      diagnostics.push({ level: "info", message: "No secrets configured." });
    }

    return diagnostics;
  },
};
