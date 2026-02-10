import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { ExtensionsConfig } from "../config/schema/extensions";
import type {
  ExtensionDiagnostic,
  ExtensionManifest,
  ExtensionToolContext,
  ExtensionToolDefinition,
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

/** Register a builtin extension factory. Called by extension modules at import time. */
export function registerBuiltinExtension(id: string, factory: BuiltinExtensionFactory): void {
  builtinFactories.set(id, factory);
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
function isExtensionEnabled(id: string, config: ExtensionsConfig): boolean {
  const entry = config.entries?.[id];
  if (!entry) {
    // No explicit entry means not explicitly enabled
    return false;
  }
  return entry.enabled !== false;
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

  const result = manifest.configSchema.safeParse(rawConfig);
  if (!result.success) {
    const issues =
      "error" in result && result.error && "issues" in result.error
        ? (result.error.issues as Array<{ path: unknown[]; message: string }>)
        : [];
    for (const issue of issues) {
      diagnostics.push({
        extensionId: manifest.id,
        level: "error",
        message: `Config validation: ${Array.isArray(issue.path) ? issue.path.join(".") : ""}: ${issue.message}`,
      });
    }
  }

  return diagnostics;
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

  // Load builtin extensions
  for (const [id, factory] of builtinFactories) {
    const diagnostics: ExtensionDiagnostic[] = [];

    // Check allow/deny
    const { allowed, reason } = isExtensionAllowed(id, config);
    if (!allowed) {
      diagnostics.push({ extensionId: id, level: "info", message: reason || "Not allowed" });
      registry.addDiagnostics(diagnostics);
      continue;
    }

    const enabled = isExtensionEnabled(id, config);
    const entryConfig = config.entries?.[id]?.config ?? {};

    try {
      const raw = factory(entryConfig);
      const { manifest, diagnostics: manifestDiags } = validateManifest(raw, `builtin:${id}`);
      diagnostics.push(...manifestDiags);

      if (!manifest) {
        registry.addDiagnostics(diagnostics);
        continue;
      }

      // Validate extension-specific config
      const configDiags = validateExtensionConfig(manifest, entryConfig);
      diagnostics.push(...configDiags);
      const hasConfigErrors = configDiags.some((d) => d.level === "error");

      if (hasConfigErrors) {
        diagnostics.push({
          extensionId: id,
          level: "error",
          message: `Extension "${id}" has config validation errors; tools will not be loaded`,
        });
        registry.register({
          manifest,
          tools: [],
          enabled: false,
          diagnostics,
        });
        continue;
      }

      // Adapt tools
      const tools: AgentTool[] = manifest.tools.map((def) => adaptTool(def, entryConfig));

      const loaded: LoadedExtension = {
        manifest,
        tools,
        enabled,
        diagnostics,
      };

      registry.register(loaded);

      if (enabled) {
        logger.info(
          { extensionId: id, tools: manifest.tools.map((t) => t.name) },
          `Extension "${id}" loaded and enabled`,
        );
      } else {
        logger.debug(`Extension "${id}" loaded but not enabled`);
      }
    } catch (error) {
      diagnostics.push({
        extensionId: id,
        level: "error",
        message: `Failed to load extension "${id}": ${error instanceof Error ? error.message : String(error)}`,
      });
      registry.addDiagnostics(diagnostics);
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
