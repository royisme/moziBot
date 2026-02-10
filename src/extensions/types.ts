import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { z } from "zod";

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
  /** Zod schema for extension-specific config validation. Optional. */
  configSchema?: z.ZodType;
  /** Tool definitions exported by this extension. */
  tools: ExtensionToolDefinition[];
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
  /** Resolved AgentTool instances for this extension. */
  tools: AgentTool[];
  /** Whether this extension is enabled. */
  enabled: boolean;
  /** Diagnostics encountered during loading. */
  diagnostics: ExtensionDiagnostic[];
};
