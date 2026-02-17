import type { AgentTool } from "@mariozechner/pi-agent-core";
import { createJiti } from "jiti";
import fs from "node:fs";
import path from "node:path";
import type { ExtensionsConfig } from "../config/schema/extensions";
import type { RuntimeHookName } from "../runtime/hooks/types";
import type {
  ExtensionCommandDefinition,
  ExtensionDiagnostic,
  ExtensionManifest,
  ExtensionRegisterApi,
  ExtensionToolContext,
  ExtensionToolDefinition,
  ExtensionHookDefinition,
  LoadedExtension,
} from "./types";
import { logger } from "../logger";
import { validateManifest } from "./manifest";
import { McpClientManager } from "./mcp";
import { ExtensionRegistry } from "./registry";

/**
 * Builtin extension factory function type.
 * Returns an ExtensionManifest given the extension config.
 */
export type BuiltinExtensionFactory = (config: Record<string, unknown>) => ExtensionManifest;

/** Map of builtin extension IDs to their factory functions. */
const builtinFactories = new Map<string, BuiltinExtensionFactory>();

const MODULE_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs"]);
const DIRECTORY_ENTRY_BASENAMES = ["mozi.extension", "openclaw.plugin", "index"];

const RUNTIME_HOOK_NAMES: Set<RuntimeHookName> = new Set([
  "before_agent_start",
  "before_tool_call",
  "after_tool_call",
  "before_reset",
  "turn_completed",
]);

const RESERVED_COMMANDS = new Set([
  "start",
  "help",
  "status",
  "whoami",
  "id",
  "new",
  "models",
  "switch",
  "model",
  "stop",
  "restart",
  "compact",
  "context",
  "setauth",
  "unsetauth",
  "listauth",
  "checkauth",
  "reminders",
  "heartbeat",
  "think",
  "thinking",
  "t",
  "reasoning",
  "reason",
]);

type ExtensionModuleCandidate = {
  source: string;
  idHint: string;
};

/** Register a builtin extension factory. Called by extension modules at import time. */
export function registerBuiltinExtension(id: string, factory: BuiltinExtensionFactory): void {
  builtinFactories.set(id, factory);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function resolveModuleExport(moduleExport: unknown): unknown {
  if (isRecord(moduleExport) && "default" in moduleExport) {
    return (moduleExport as { default: unknown }).default;
  }
  return moduleExport;
}

/**
 * Convert an ExtensionToolDefinition to an AgentTool with the proper execution context.
 */
function adaptTool(
  def: ExtensionToolDefinition,
  extensionConfig: Record<string, unknown>,
): AgentTool {
  const ctx: ExtensionToolContext = { extensionConfig };
  return {
    name: def.name,
    label: def.label,
    description: def.description,
    parameters: def.parameters,
    execute: async (toolCallId: string, args: unknown) => {
      return def.execute(toolCallId, args as Record<string, unknown>, ctx);
    },
  };
}

/**
 * Check whether an extension is allowed by allow/deny lists.
 */
function isExtensionAllowed(
  id: string,
  config: ExtensionsConfig,
): { allowed: boolean; reason?: string } {
  if (config.deny && config.deny.includes(id)) {
    return { allowed: false, reason: `Extension "${id}" is in the deny list` };
  }
  if (config.allow && !config.allow.includes(id)) {
    return { allowed: false, reason: `Extension "${id}" is not in the allow list` };
  }
  return { allowed: true };
}

/**
 * Check whether an extension is enabled in its entry config.
 */
function isExtensionEnabled(
  id: string,
  config: ExtensionsConfig,
  opts?: { defaultEnabled?: boolean },
): boolean {
  const entry = config.entries?.[id];
  if (!entry) {
    return opts?.defaultEnabled === true;
  }
  return entry.enabled !== false;
}

function validateWithSafeParse(
  schema: { safeParse: (value: unknown) => unknown },
  rawConfig: Record<string, unknown>,
  extensionId: string,
): ExtensionDiagnostic[] {
  const diagnostics: ExtensionDiagnostic[] = [];
  const result = schema.safeParse(rawConfig) as {
    success?: boolean;
    error?: { issues?: Array<{ path: Array<string | number>; message: string }> };
  };

  if (result.success) {
    return diagnostics;
  }

  const issues = result.error?.issues ?? [];
  for (const issue of issues) {
    diagnostics.push({
      extensionId,
      level: "error",
      message: `Config validation: ${issue.path.join(".")}: ${issue.message}`,
    });
  }
  if (issues.length === 0) {
    diagnostics.push({
      extensionId,
      level: "error",
      message: "Config validation failed",
    });
  }
  return diagnostics;
}

/**
 * Validate extension-specific config against the manifest's configSchema.
 */
function validateExtensionConfig(
  manifest: ExtensionManifest,
  rawConfig: Record<string, unknown>,
): ExtensionDiagnostic[] {
  const diagnostics: ExtensionDiagnostic[] = [];

  if (!manifest.configSchema) {
    return diagnostics;
  }

  const schema = manifest.configSchema;

  if (schema && typeof (schema as { safeParse?: unknown }).safeParse === "function") {
    return validateWithSafeParse(
      schema as { safeParse: (value: unknown) => unknown },
      rawConfig,
      manifest.id,
    );
  }

  if (schema && typeof (schema as { validate?: unknown }).validate === "function") {
    const result = (
      schema as { validate: (value: unknown) => { ok: boolean; errors?: string[] } }
    ).validate(rawConfig);
    if (result.ok) {
      return diagnostics;
    }
    for (const error of result.errors ?? ["Config validation failed"]) {
      diagnostics.push({
        extensionId: manifest.id,
        level: "error",
        message: `Config validation: ${error}`,
      });
    }
    return diagnostics;
  }

  if (schema && typeof (schema as { parse?: unknown }).parse === "function") {
    try {
      (schema as { parse: (value: unknown) => unknown }).parse(rawConfig);
    } catch (error) {
      diagnostics.push({
        extensionId: manifest.id,
        level: "error",
        message: `Config validation: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
    return diagnostics;
  }

  diagnostics.push({
    extensionId: manifest.id,
    level: "warn",
    message: "Config schema does not expose safeParse/validate/parse; skipped config validation",
  });
  return diagnostics;
}

function isModuleFile(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  if (!MODULE_EXTENSIONS.has(ext)) {
    return false;
  }
  return !filePath.endsWith(".d.ts");
}

function findEntryModuleInDirectory(dirPath: string): string | null {
  for (const basename of DIRECTORY_ENTRY_BASENAMES) {
    for (const ext of MODULE_EXTENSIONS) {
      const candidate = path.join(dirPath, `${basename}${ext}`);
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        return candidate;
      }
    }
  }
  return null;
}

function pushModuleCandidate(
  candidate: ExtensionModuleCandidate,
  seen: Set<string>,
  output: ExtensionModuleCandidate[],
): void {
  const resolved = path.resolve(candidate.source);
  if (seen.has(resolved)) {
    return;
  }
  seen.add(resolved);
  output.push({
    source: resolved,
    idHint: candidate.idHint,
  });
}

function discoverExternalExtensionCandidates(config: ExtensionsConfig): {
  candidates: ExtensionModuleCandidate[];
  diagnostics: ExtensionDiagnostic[];
} {
  const diagnostics: ExtensionDiagnostic[] = [];
  const candidates: ExtensionModuleCandidate[] = [];
  const seen = new Set<string>();

  for (const rawPath of config.load?.paths ?? []) {
    if (typeof rawPath !== "string" || !rawPath.trim()) {
      continue;
    }
    const resolvedPath = path.resolve(rawPath);
    if (!fs.existsSync(resolvedPath)) {
      diagnostics.push({
        extensionId: "external",
        level: "error",
        message: `Extension path not found: ${resolvedPath}`,
      });
      continue;
    }

    const stat = fs.statSync(resolvedPath);
    if (stat.isFile()) {
      if (!isModuleFile(resolvedPath)) {
        diagnostics.push({
          extensionId: "external",
          level: "error",
          message: `Unsupported extension file: ${resolvedPath}`,
        });
        continue;
      }
      pushModuleCandidate(
        {
          source: resolvedPath,
          idHint: path.basename(resolvedPath, path.extname(resolvedPath)),
        },
        seen,
        candidates,
      );
      continue;
    }

    if (!stat.isDirectory()) {
      diagnostics.push({
        extensionId: "external",
        level: "error",
        message: `Unsupported extension path type: ${resolvedPath}`,
      });
      continue;
    }

    const directEntry = findEntryModuleInDirectory(resolvedPath);
    if (directEntry) {
      pushModuleCandidate(
        {
          source: directEntry,
          idHint: path.basename(resolvedPath),
        },
        seen,
        candidates,
      );
    }

    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(resolvedPath, { withFileTypes: true });
    } catch (error) {
      diagnostics.push({
        extensionId: "external",
        level: "error",
        message: `Failed to read extension directory ${resolvedPath}: ${String(error)}`,
      });
      continue;
    }

    for (const entry of entries) {
      const fullPath = path.join(resolvedPath, entry.name);
      if (entry.isFile() && isModuleFile(fullPath)) {
        pushModuleCandidate(
          {
            source: fullPath,
            idHint: path.basename(entry.name, path.extname(entry.name)),
          },
          seen,
          candidates,
        );
        continue;
      }

      if (entry.isDirectory()) {
        const nestedEntry = findEntryModuleInDirectory(fullPath);
        if (nestedEntry) {
          pushModuleCandidate(
            {
              source: nestedEntry,
              idHint: entry.name,
            },
            seen,
            candidates,
          );
        }
      }
    }
  }

  return { candidates, diagnostics };
}

function normalizeCommandName(name: string): string {
  return name.trim().replace(/^\/+/, "").toLowerCase();
}

function validateCommandName(name: string): string | null {
  if (!name) {
    return "command name cannot be empty";
  }
  if (!/^[a-z][a-z0-9_-]*$/.test(name)) {
    return "command name must start with a letter and contain only letters, numbers, hyphens, and underscores";
  }
  if (RESERVED_COMMANDS.has(name)) {
    return `command name "${name}" is reserved by built-in commands`;
  }
  return null;
}

function releaseCommandOwnersForExtension(extensionId: string, owners: Map<string, string>): void {
  for (const [name, owner] of owners.entries()) {
    if (owner === extensionId) {
      owners.delete(name);
    }
  }
}

function loadSingleExtension(params: {
  source: string;
  rawDefinition: unknown;
  enabledDefault: boolean;
  config: ExtensionsConfig;
  registry: ExtensionRegistry;
  commandOwners: Map<string, string>;
}): void {
  const diagnostics: ExtensionDiagnostic[] = [];
  const { manifest, diagnostics: manifestDiags } = validateManifest(
    params.rawDefinition,
    params.source,
  );
  diagnostics.push(...manifestDiags);

  if (!manifest) {
    params.registry.addDiagnostics(diagnostics);
    return;
  }

  const extensionId = manifest.id;
  const { allowed, reason } = isExtensionAllowed(extensionId, params.config);
  if (!allowed) {
    params.registry.addDiagnostics([
      ...diagnostics,
      { extensionId, level: "info", message: reason || "Not allowed" },
    ]);
    return;
  }

  const existing = params.registry.get(extensionId);
  if (existing) {
    releaseCommandOwnersForExtension(extensionId, params.commandOwners);
    diagnostics.push({
      extensionId,
      level: "warn",
      message: `Extension id collision: overriding previous registration from ${existing.source}`,
    });
  }

  const entryConfig = params.config.entries?.[extensionId]?.config ?? {};
  const configDiags = validateExtensionConfig(manifest, entryConfig);
  diagnostics.push(...configDiags);
  const hasConfigErrors = configDiags.some((diag) => diag.level === "error");

  const rawTools: ExtensionToolDefinition[] = [...(manifest.tools ?? [])];
  const rawHooks: ExtensionHookDefinition[] = [...(manifest.hooks ?? [])];
  const rawCommands: ExtensionCommandDefinition[] = [...(manifest.commands ?? [])];

  if (typeof manifest.register === "function") {
    const api: ExtensionRegisterApi = {
      id: extensionId,
      name: manifest.name,
      version: manifest.version,
      description: manifest.description,
      extensionConfig: entryConfig,
      registerTool: (tool) => {
        rawTools.push(tool);
      },
      registerCommand: (command) => {
        rawCommands.push(command);
      },
      registerHook: (hookName, handler, opts) => {
        rawHooks.push({
          hookName,
          handler,
          priority: opts?.priority,
          id: opts?.id,
        });
      },
    };

    try {
      const maybePromise = manifest.register(api);
      if (maybePromise && typeof (maybePromise as Promise<unknown>).then === "function") {
        diagnostics.push({
          extensionId,
          level: "warn",
          message: "Extension register returned a Promise; async registration is ignored",
        });
      }
    } catch (error) {
      diagnostics.push({
        extensionId,
        level: "error",
        message: `Extension register failed: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  const hooks: ExtensionHookDefinition[] = [];
  for (const hook of rawHooks) {
    const hookName = typeof hook.hookName === "string" ? hook.hookName.trim() : "";
    if (!hookName || !RUNTIME_HOOK_NAMES.has(hookName as RuntimeHookName)) {
      diagnostics.push({
        extensionId,
        level: "warn",
        message: `Unknown runtime hook "${hookName || "<empty>"}"; ignored`,
      });
      continue;
    }
    if (typeof hook.handler !== "function") {
      diagnostics.push({
        extensionId,
        level: "error",
        message: `Runtime hook "${hookName}" has no valid handler`,
      });
      continue;
    }
    hooks.push({
      hookName: hookName as RuntimeHookName,
      handler: hook.handler,
      priority: typeof hook.priority === "number" ? hook.priority : undefined,
      id: typeof hook.id === "string" && hook.id.trim() ? hook.id.trim() : undefined,
    });
  }

  const commands: ExtensionCommandDefinition[] = [];
  for (const command of rawCommands) {
    const normalizedName = normalizeCommandName(command.name);
    const nameError = validateCommandName(normalizedName);
    if (nameError) {
      diagnostics.push({
        extensionId,
        level: "error",
        message: `Invalid command "${command.name}": ${nameError}`,
      });
      continue;
    }
    if (typeof command.handler !== "function") {
      diagnostics.push({
        extensionId,
        level: "error",
        message: `Command "${normalizedName}" is missing handler`,
      });
      continue;
    }

    const existingOwner = params.commandOwners.get(normalizedName);
    if (existingOwner && existingOwner !== extensionId) {
      diagnostics.push({
        extensionId,
        level: "error",
        message: `Command "${normalizedName}" already registered by extension "${existingOwner}"`,
      });
      continue;
    }

    params.commandOwners.set(normalizedName, extensionId);
    commands.push({
      ...command,
      name: normalizedName,
    });
  }

  let enabled = isExtensionEnabled(extensionId, params.config, {
    defaultEnabled: params.enabledDefault,
  });

  const hasRegistrationErrors = diagnostics.some((diag) => diag.level === "error");
  if (hasConfigErrors || hasRegistrationErrors) {
    enabled = false;
  }

  const tools: AgentTool[] = enabled ? rawTools.map((def) => adaptTool(def, entryConfig)) : [];
  const resolvedHooks = enabled ? hooks : [];
  const resolvedCommands = enabled ? commands : [];

  const loaded: LoadedExtension = {
    manifest: {
      ...manifest,
      tools: rawTools,
      hooks,
      commands,
    },
    source: params.source,
    tools,
    hooks: resolvedHooks,
    commands: resolvedCommands,
    enabled,
    diagnostics,
  };

  params.registry.register(loaded);

  if (enabled) {
    logger.info(
      {
        extensionId,
        source: params.source,
        tools: tools.map((tool) => tool.name),
        hooks: resolvedHooks.map((hook) => hook.hookName),
        commands: resolvedCommands.map((command) => command.name),
      },
      `Extension "${extensionId}" loaded and enabled`,
    );
  } else {
    logger.debug(`Extension "${extensionId}" loaded but disabled`);
  }
}

/**
 * Load all extensions (builtin + discovered) and populate the registry.
 */
export function loadExtensions(config: ExtensionsConfig | undefined): ExtensionRegistry {
  const registry = new ExtensionRegistry();

  if (!config || config.enabled === false) {
    logger.debug("Extension subsystem is disabled");
    return registry;
  }

  const commandOwners = new Map<string, string>();

  // Load builtin extensions.
  for (const [id, factory] of builtinFactories) {
    try {
      const entryConfig = config.entries?.[id]?.config ?? {};
      const raw = factory(entryConfig);
      loadSingleExtension({
        source: `builtin:${id}`,
        rawDefinition: raw,
        enabledDefault: false,
        config,
        registry,
        commandOwners,
      });
    } catch (error) {
      registry.addDiagnostics([
        {
          extensionId: id,
          level: "error",
          message: `Failed to construct builtin extension "${id}": ${error instanceof Error ? error.message : String(error)}`,
        },
      ]);
    }
  }

  // Load external extension modules from extensions.load.paths.
  const discovery = discoverExternalExtensionCandidates(config);
  if (discovery.diagnostics.length > 0) {
    registry.addDiagnostics(discovery.diagnostics);
  }

  if (discovery.candidates.length > 0) {
    const jitiLoader = createJiti(import.meta.url, {
      interopDefault: true,
      extensions: [".ts", ".tsx", ".mts", ".cts", ".mjs", ".cjs", ".js", ".json"],
    });

    for (const candidate of discovery.candidates) {
      try {
        const rawModule = jitiLoader(candidate.source) as unknown;
        const rawDefinition = resolveModuleExport(rawModule);
        loadSingleExtension({
          source: candidate.source,
          rawDefinition,
          enabledDefault: true,
          config,
          registry,
          commandOwners,
        });
      } catch (error) {
        registry.addDiagnostics([
          {
            extensionId: candidate.idHint || "external",
            level: "error",
            message: `Failed to load external extension at ${candidate.source}: ${error instanceof Error ? error.message : String(error)}`,
          },
        ]);
      }
    }
  }

  return registry;
}

/**
 * Initialize async extension sources (e.g. MCP servers) and register their tools.
 * This is async because some sources require spawning processes and protocol handshake.
 * Should be called after loadExtensions() to add async extension tools.
 */
export async function initExtensionsAsync(
  config: ExtensionsConfig | undefined,
  registry: ExtensionRegistry,
): Promise<void> {
  if (!config || config.enabled === false) {
    return;
  }

  const mcpServers = config.mcpServers;
  if (!mcpServers || Object.keys(mcpServers).length === 0) {
    return;
  }

  const manager = new McpClientManager();
  registry.setMcpManager(manager);

  for (const [id, entry] of Object.entries(mcpServers)) {
    // Check allow/deny
    const mcpExtId = `mcp:${id}`;
    const { allowed, reason } = isExtensionAllowed(mcpExtId, config);
    if (!allowed) {
      registry.addDiagnostics([
        { extensionId: mcpExtId, level: "info", message: reason || "Not allowed" },
      ]);
      continue;
    }

    const { extension, diagnostics } = await manager.connectServer(id, entry);
    registry.register(extension);
    if (diagnostics.length > 0) {
      registry.addDiagnostics(diagnostics);
    }
  }
}
