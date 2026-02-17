import JSON5 from "json5";
import fs from "node:fs";
import { promises as fsp } from "node:fs";
import type { MoziConfig } from "../../config";
import {
  applyConfigOps,
  CONFIG_REDACTION_SENTINEL,
  deleteConfigValue,
  isConfigConflictError,
  loadConfig,
  patchConfig,
  readConfigSnapshot,
  setConfigValue,
  writeConfigRawAtomic,
} from "../../config";
import { resolveAgentModelRouting } from "../../config/model-routing";
import { ModelRegistry } from "../../runtime/model-registry";
import { ProviderRegistry } from "../../runtime/provider-registry";
import { bootstrapSandboxes } from "../../runtime/sandbox/bootstrap";

export async function validateConfig(configPath?: string) {
  const result = loadConfig(configPath);
  if (result.success) {
    console.log("✅ Config check passed. The config file is valid.");
    return;
  }
  console.error("❌ Config check failed. Invalid config file:");
  for (const error of result.errors ?? []) {
    console.error(`- ${error}`);
  }
  process.exit(1);
}

function parseJsonValue(raw: string): unknown {
  try {
    return JSON5.parse(raw);
  } catch {
    return raw;
  }
}

function parsePatchValue(raw: string): Record<string, unknown> {
  const parsed = parseJsonValue(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Patch must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

function parseOperations(raw: string) {
  const parsed = parseJsonValue(raw);
  if (!Array.isArray(parsed)) {
    throw new Error("Apply operations must be a JSON array");
  }
  for (const item of parsed) {
    if (!item || typeof item !== "object" || Array.isArray(item) || !("op" in item)) {
      throw new Error("Each operation must be an object with an op field");
    }
    const op = (item as { op?: unknown }).op;
    if (op !== "set" && op !== "delete" && op !== "patch") {
      throw new Error(`Unsupported op: ${String(op)}`);
    }
  }
  return parsed as Array<
    | { op: "set"; path: string; value: unknown }
    | { op: "delete"; path: string }
    | { op: "patch"; value: Record<string, unknown> }
  >;
}

function readArgOrFile(
  input: string | undefined,
  filePath: string | undefined,
  kind: string,
): string {
  if (filePath) {
    return fs.readFileSync(filePath, "utf-8");
  }
  if (!input) {
    throw new Error(`${kind} is required (argument or --file)`);
  }
  return input;
}

function printSnapshot(snapshot: ReturnType<typeof readConfigSnapshot>, asJson: boolean): void {
  if (asJson) {
    console.log(
      JSON.stringify(
        {
          path: snapshot.path,
          exists: snapshot.exists,
          rawHash: snapshot.rawHash,
          effectiveHash: snapshot.effectiveHash,
          valid: snapshot.load.success,
          errors: snapshot.load.errors ?? [],
        },
        null,
        2,
      ),
    );
    return;
  }
  console.log(`path: ${snapshot.path}`);
  console.log(`exists: ${snapshot.exists}`);
  console.log(`rawHash: ${snapshot.rawHash}`);
  console.log(`effectiveHash: ${snapshot.effectiveHash ?? "<invalid>"}`);
  console.log(`valid: ${snapshot.load.success}`);
  if (!snapshot.load.success) {
    for (const error of snapshot.load.errors ?? []) {
      console.log(`error: ${error}`);
    }
  }
}

function handleMutationError(error: unknown): never {
  if (isConfigConflictError(error)) {
    console.error(`❌ Config write rejected: conflict detected (${error.message})`);
    process.exit(2);
  }
  console.error(
    `❌ Config write failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
}

function printMutationSuccess(label: string, rawHash: string): void {
  console.log(`✅ ${label}`);
  console.log(`rawHash: ${rawHash}`);
}

function hasRedactedValue(value: unknown): boolean {
  if (value === CONFIG_REDACTION_SENTINEL) {
    return true;
  }
  if (Array.isArray(value)) {
    return value.some((item) => hasRedactedValue(item));
  }
  if (value && typeof value === "object") {
    return Object.values(value as Record<string, unknown>).some((item) => hasRedactedValue(item));
  }
  return false;
}

function collectBlockingSecretIssues(config: MoziConfig): string[] {
  const issues: string[] = [];
  const unresolvedEnvPattern = /^\$\{[^}]+\}$/;
  const providers = config.models?.providers ?? {};
  for (const [provider, entry] of Object.entries(providers)) {
    if (entry.apiKey === CONFIG_REDACTION_SENTINEL) {
      issues.push(`Provider ${provider} apiKey is redacted sentinel and must be replaced.`);
    }
    if (typeof entry.apiKey === "string" && unresolvedEnvPattern.test(entry.apiKey)) {
      issues.push(`Provider ${provider} apiKey is unresolved env placeholder.`);
    }
  }
  const telegram = config.channels?.telegram;
  if (telegram?.enabled) {
    if (telegram.botToken === CONFIG_REDACTION_SENTINEL) {
      issues.push("Telegram botToken is redacted sentinel and must be replaced.");
    }
    if (typeof telegram.botToken === "string" && unresolvedEnvPattern.test(telegram.botToken)) {
      issues.push("Telegram botToken is unresolved env placeholder.");
    }
  }
  const discord = config.channels?.discord;
  if (discord?.enabled) {
    if (discord.botToken === CONFIG_REDACTION_SENTINEL) {
      issues.push("Discord botToken is redacted sentinel and must be replaced.");
    }
    if (typeof discord.botToken === "string" && unresolvedEnvPattern.test(discord.botToken)) {
      issues.push("Discord botToken is unresolved env placeholder.");
    }
  }
  const localDesktop = config.channels?.localDesktop;
  if (localDesktop?.enabled) {
    if (localDesktop.authToken === CONFIG_REDACTION_SENTINEL) {
      issues.push("Local desktop authToken is redacted sentinel and must be replaced.");
    }
    if (
      typeof localDesktop.authToken === "string" &&
      unresolvedEnvPattern.test(localDesktop.authToken)
    ) {
      issues.push("Local desktop authToken is unresolved env placeholder.");
    }
  }
  return issues;
}

type DoctorReport = {
  errors: string[];
  warnings: string[];
};

function collectDoctorReport(config: MoziConfig): DoctorReport {
  const errors: string[] = [];
  const warnings: string[] = [];

  const agentEntries = listAgentEntries(config);
  if (agentEntries.length === 0) {
    errors.push("No agents configured. Add at least one agent entry under agents.");
  }

  const modelRegistry = new ModelRegistry(config);
  const providerRegistry = new ProviderRegistry(config);

  for (const { id } of agentEntries) {
    const routing = resolveAgentModelRouting(config, id);
    const modelRef = routing.defaultModel.primary;
    if (!modelRef) {
      errors.push(`Agent ${id} has no model configured.`);
      continue;
    }
    const spec = modelRegistry.get(modelRef);
    if (!spec) {
      errors.push(`Agent ${id} references unknown model: ${modelRef}`);
      continue;
    }
    const apiKey = providerRegistry.resolveApiKey(spec.provider);
    if (!apiKey) {
      warnings.push(`Provider ${spec.provider} has no API key (agent ${id}).`);
    }

    const modalityEntries: Array<{ input: "image"; refs: string[] }> = [
      {
        input: "image",
        refs: [routing.imageModel.primary, ...routing.imageModel.fallbacks].filter(
          (ref): ref is string => Boolean(ref),
        ),
      },
    ];

    for (const modality of modalityEntries) {
      for (const ref of modality.refs) {
        const modSpec = modelRegistry.get(ref);
        if (!modSpec) {
          errors.push(`Agent ${id} ${modality.input} route references unknown model: ${ref}`);
          continue;
        }
        if (!(modSpec.input ?? ["text"]).includes(modality.input)) {
          warnings.push(
            `Agent ${id} ${modality.input} route model ${ref} does not declare ${modality.input} input capability.`,
          );
        }
      }
    }
  }

  const channels = config.channels ?? {};
  const telegram = channels.telegram;
  if (telegram?.enabled && !telegram.botToken) {
    errors.push("Telegram is enabled but botToken is missing.");
  }
  const discord = channels.discord;
  if (discord?.enabled && !discord.botToken) {
    errors.push("Discord is enabled but botToken is missing.");
  }

  for (const agentId of referencedAgents(channels)) {
    if (!agentEntries.some((entry) => entry.id === agentId)) {
      errors.push(`Channel references unknown agent: ${agentId}`);
    }
  }

  const heartbeatIssues = validateHeartbeat(config, agentEntries);
  errors.push(...heartbeatIssues.errors);
  warnings.push(...heartbeatIssues.warnings);

  const secretIssues = collectBlockingSecretIssues(config);
  errors.push(...secretIssues);

  if (hasRedactedValue(config)) {
    warnings.push("Config contains redaction sentinel values.");
  }

  if (config.extensions?.installs && Object.keys(config.extensions.installs).length > 0) {
    warnings.push(
      "extensions.installs is currently metadata only and does not auto-install extension packages.",
    );
  }

  return { errors, warnings };
}

async function rollbackConfig(
  before: ReturnType<typeof readConfigSnapshot>,
  after: ReturnType<typeof readConfigSnapshot>,
): Promise<void> {
  if (before.exists) {
    await writeConfigRawAtomic(before.path, before.raw ?? "{}\n", {
      expectedRawHash: after.rawHash,
    });
    return;
  }
  const current = readConfigSnapshot(before.path);
  if (current.rawHash !== after.rawHash) {
    throw new Error("Config changed during rollback; manual intervention required");
  }
  if (current.exists) {
    await fsp.unlink(before.path);
  }
}

function printDoctorReport(report: DoctorReport): void {
  if (report.errors.length === 0) {
    console.log("✅ Config check passed. The config is runnable.");
  } else {
    console.error("❌ Config check failed with blocking issues:");
    for (const error of report.errors) {
      console.error(`- ${error}`);
    }
  }

  if (report.warnings.length > 0) {
    console.warn("\n⚠️ Warnings:");
    for (const warn of report.warnings) {
      console.warn(`- ${warn}`);
    }
  }
}

async function postMutationValidateOrRollback(
  mutationLabel: string,
  before: ReturnType<typeof readConfigSnapshot>,
  after: ReturnType<typeof readConfigSnapshot>,
): Promise<void> {
  if (!after.load.success || !after.load.config) {
    await rollbackConfig(before, after);
    console.error(
      `❌ ${mutationLabel} rejected: the resulting config could not be loaded. Changes were rolled back.`,
    );
    for (const error of after.load.errors ?? []) {
      console.error(`- ${error}`);
    }
    process.exit(1);
  }
  const report = collectDoctorReport(after.load.config);
  if (report.errors.length > 0) {
    await rollbackConfig(before, after);
    console.error(`❌ ${mutationLabel} rejected by config checks. Changes were rolled back.`);
    printDoctorReport(report);
    process.exit(1);
  }
  if (report.warnings.length > 0) {
    printDoctorReport(report);
  }
}

export async function snapshotConfig(options: { config?: string; json?: boolean }) {
  const snapshot = readConfigSnapshot(options.config);
  printSnapshot(snapshot, Boolean(options.json));
  if (!snapshot.load.success) {
    process.exit(1);
  }
}

export async function setConfigEntry(
  entryPath: string,
  rawValue: string,
  options: { config?: string; json?: boolean; ifHash?: string },
) {
  try {
    const value = options.json ? JSON5.parse(rawValue) : parseJsonValue(rawValue);
    const result = await setConfigValue({
      path: entryPath,
      value,
      options: {
        configPath: options.config,
        expectedRawHash: options.ifHash,
      },
    });
    await postMutationValidateOrRollback("Configuration update", result.before, result.after);

    printMutationSuccess("Config updated.", result.after.rawHash);
  } catch (error) {
    handleMutationError(error);
  }
}

export async function unsetConfigEntry(
  entryPath: string,
  options: { config?: string; ifHash?: string },
) {
  try {
    const result = await deleteConfigValue({
      path: entryPath,
      options: {
        configPath: options.config,
        expectedRawHash: options.ifHash,
      },
    });
    await postMutationValidateOrRollback("Configuration update", result.before, result.after);
    printMutationSuccess("Config updated.", result.after.rawHash);
  } catch (error) {
    handleMutationError(error);
  }
}

export async function patchConfigEntry(
  rawPatch: string | undefined,
  options: { config?: string; ifHash?: string; file?: string },
) {
  try {
    const content = readArgOrFile(rawPatch, options.file, "Patch payload");
    const patch = parsePatchValue(content);
    const result = await patchConfig({
      patch,
      options: {
        configPath: options.config,
        expectedRawHash: options.ifHash,
      },
    });
    await postMutationValidateOrRollback("Configuration patch", result.before, result.after);
    printMutationSuccess("Config patched.", result.after.rawHash);
  } catch (error) {
    handleMutationError(error);
  }
}

export async function applyConfigOperations(
  rawOperations: string | undefined,
  options: { config?: string; ifHash?: string; file?: string },
) {
  try {
    const content = readArgOrFile(rawOperations, options.file, "Operations payload");
    const operations = parseOperations(content);
    const result = await applyConfigOps({
      operations,
      options: {
        configPath: options.config,
        expectedRawHash: options.ifHash,
      },
    });
    await postMutationValidateOrRollback("Configuration apply", result.before, result.after);
    printMutationSuccess("Config applied.", result.after.rawHash);
  } catch (error) {
    handleMutationError(error);
  }
}

export async function doctorConfig(configPath?: string, options: { fix?: boolean } = {}) {
  const result = loadConfig(configPath);
  if (!result.success || !result.config) {
    console.error("❌ Config check failed. Invalid config file:");
    for (const error of result.errors ?? []) {
      console.error(`- ${error}`);
    }
    process.exit(1);
  }

  const config = result.config;
  const report = collectDoctorReport(config);
  const errors = [...report.errors];
  const warnings = [...report.warnings];

  if (options.fix) {
    if (errors.length > 0) {
      warnings.push("Sandbox bootstrap skipped because blocking config issues exist.");
    } else {
      const bootstrap = await bootstrapSandboxes(config, { fix: true });
      for (const action of bootstrap.actions) {
        console.log(`🔧 [${action.agentId}] ${action.message}`);
      }
      for (const issue of bootstrap.issues) {
        const line = `[${issue.agentId}] ${issue.message}`;
        if (issue.level === "error") {
          errors.push(line);
        } else {
          warnings.push(line);
        }
        for (const hint of issue.hints) {
          warnings.push(`[${issue.agentId}] hint: ${hint}`);
        }
      }
    }
  }

  printDoctorReport({ errors, warnings });

  if (errors.length > 0) {
    process.exit(1);
  }
}

type AgentEntry = {
  id: string;
  entry: {
    heartbeat?: { enabled?: boolean; every?: string; prompt?: string };
  };
};

function listAgentEntries(config: MoziConfig): AgentEntry[] {
  const agents = config.agents || {};
  return Object.entries(agents)
    .filter(([key]) => key !== "defaults")
    .map(([id, entry]) => ({ id, entry: entry as AgentEntry["entry"] }));
}

function referencedAgents(channels: MoziConfig["channels"]): string[] {
  const ids: string[] = [];
  if (channels?.telegram?.agentId) {
    ids.push(channels.telegram.agentId);
  }
  if (channels?.telegram?.agent) {
    ids.push(channels.telegram.agent);
  }
  if (channels?.discord?.agentId) {
    ids.push(channels.discord.agentId);
  }
  if (channels?.discord?.agent) {
    ids.push(channels.discord.agent);
  }
  if (channels?.routing?.dmAgentId) {
    ids.push(channels.routing.dmAgentId);
  }
  if (channels?.routing?.dmAgent) {
    ids.push(channels.routing.dmAgent);
  }
  if (channels?.routing?.groupAgentId) {
    ids.push(channels.routing.groupAgentId);
  }
  if (channels?.routing?.groupAgent) {
    ids.push(channels.routing.groupAgent);
  }
  return Array.from(new Set(ids));
}

function validateHeartbeat(config: MoziConfig, agentEntries: AgentEntry[]) {
  const errors: string[] = [];
  const warnings: string[] = [];
  const defaults = (
    config.agents?.defaults as { heartbeat?: { enabled?: boolean; every?: string } } | undefined
  )?.heartbeat;
  for (const { id, entry } of agentEntries) {
    const hb = entry.heartbeat ?? defaults;
    if (!hb?.enabled) {
      continue;
    }
    const every = hb.every ?? "30m";
    if (!parseEveryMs(every)) {
      errors.push(`Agent ${id} heartbeat.every is invalid: ${every}`);
    }
  }
  if (!defaults?.enabled) {
    warnings.push(
      "Heartbeat defaults are disabled. No periodic checks will run unless enabled per agent.",
    );
  }
  return { errors, warnings };
}

function parseEveryMs(raw: string): number | null {
  const value = raw.trim().toLowerCase();
  if (!value) {
    return null;
  }
  const match = /^([0-9]+)\s*(ms|s|m|h|d)$/.exec(value);
  if (!match) {
    return null;
  }
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) {
    return null;
  }
  const unit = match[2];
  const multipliers: Record<string, number> = {
    ms: 1,
    s: 1000,
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
  };
  return amount * (multipliers[unit] || 0);
}
