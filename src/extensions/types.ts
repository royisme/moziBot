import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { z } from "zod";
import type { RuntimeHookHandlerMap, RuntimeHookName } from "../runtime/hooks/types";

/**
 * Tool definition exported by an extension.
 * Each tool becomes an AgentTool at runtime.
 */
export type ExtensionToolDefinition = {
  /** Tool name as exposed to the agent (e.g. "web_search"). */
  name: string;
  /** Human-readable label. */
  label: string;
  /** Description shown to the model. */
  description: string;
  /** JSON Schema for parameters (TypeBox-compatible object). */
  parameters: unknown;
  /** Execute function: receives tool call ID and parsed args, returns AgentTool result. */
  execute: (
    toolCallId: string,
    args: Record<string, unknown>,
    context: ExtensionToolContext,
  ) => Promise<{
    content: Array<{ type: string; text: string }>;
    details: Record<string, unknown>;
  }>;
};

export type ExtensionConfigValidation =
  | { ok: true; value?: unknown }
  | { ok: false; errors: string[] };

export type ExtensionConfigSchema =
  | z.ZodType
  | {
      safeParse?: (value: unknown) => {
        success: boolean;
        data?: unknown;
        error?: {
          issues?: Array<{ path: Array<string | number>; message: string }>;
        };
      };
      parse?: (value: unknown) => unknown;
      validate?: (value: unknown) => ExtensionConfigValidation;
      jsonSchema?: Record<string, unknown>;
    };

export type ExtensionCommandContext = {
  sessionKey: string;
  agentId: string;
  peerId: string;
  channelId: string;
  args: string;
  message: unknown;
  sendReply: (text: string) => Promise<void>;
};

export type ExtensionCommandResult = {
  text: string;
};

export type ExtensionCommandDefinition = {
  name: string;
  description: string;
  acceptsArgs?: boolean;
  handler: (
    ctx: ExtensionCommandContext,
  ) => Promise<ExtensionCommandResult | void> | ExtensionCommandResult | void;
};

export type ExtensionHookDefinition<K extends RuntimeHookName = RuntimeHookName> = {
  hookName: K;
  handler: RuntimeHookHandlerMap[K];
  priority?: number;
  id?: string;
};

export type ExtensionRegisterApi = {
  id: string;
  name: string;
  version: string;
  description?: string;
  extensionConfig: Record<string, unknown>;
  registerTool: (tool: ExtensionToolDefinition) => void;
  registerCommand: (command: ExtensionCommandDefinition) => void;
  registerHook: <K extends RuntimeHookName>(
    hookName: K,
    handler: RuntimeHookHandlerMap[K],
    opts?: { priority?: number; id?: string },
  ) => void;
};

/**
 * Context provided to extension tools at execution time.
 */
export type ExtensionToolContext = {
  /** Extension-specific config from entries.<id>.config. */
  extensionConfig: Record<string, unknown>;
};

/**
 * Extension manifest: the static metadata + factory exported by an extension module.
 */
export type ExtensionManifest = {
  /** Unique extension ID (e.g. "web-tavily"). */
  id: string;
  /** SemVer version string. */
  version: string;
  /** Human-readable name. */
  name: string;
  /** Short description. */
  description?: string;
  /** Extension-specific config validation schema. Optional. */
  configSchema?: ExtensionConfigSchema;
  /** Tool definitions exported by this extension. */
  tools?: ExtensionToolDefinition[];
  /** Command definitions exported by this extension. */
  commands?: ExtensionCommandDefinition[];
  /** Runtime hook definitions exported by this extension. */
  hooks?: ExtensionHookDefinition[];
  /**
   * Optional plugin-style registration callback.
   * Allows dynamic registration of tools/commands/hooks through a stable API.
   */
  register?: (api: ExtensionRegisterApi) => void | Promise<void>;
  /** Directories of skills exported by this extension (absolute paths). */
  skillDirs?: string[];
};

/**
 * Diagnostic entry for extension loading issues.
 */
export type ExtensionDiagnostic = {
  extensionId: string;
  level: "info" | "warn" | "error";
  message: string;
};

/**
 * A loaded and validated extension, ready for registration.
 */
export type LoadedExtension = {
  manifest: ExtensionManifest;
  source: string;
  /** Resolved AgentTool instances for this extension. */
  tools: AgentTool[];
  /** Hook registrations exported by this extension. */
  hooks: ExtensionHookDefinition[];
  /** Command registrations exported by this extension. */
  commands: ExtensionCommandDefinition[];
  /** Whether this extension is enabled. */
  enabled: boolean;
  /** Diagnostics encountered during loading. */
  diagnostics: ExtensionDiagnostic[];
};
