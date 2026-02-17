import { z } from "zod";

/**
 * Per-extension entry configuration.
 * `config` is extension-owned and validated by the extension's own schema at load time.
 */
export const ExtensionEntrySchema = z
  .object({
    enabled: z.boolean().optional(),
    config: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

/**
 * Install record for a single extension, tracking provenance.
 */
export const ExtensionInstallRecordSchema = z
  .object({
    source: z.enum(["npm", "path", "archive", "git"]),
    spec: z.string(),
    installedAt: z.string().optional(),
  })
  .strict();

/**
 * MCP server entry: standard MCP config format (command/args/env).
 * Compatible with the convention used by Claude Desktop, Cursor, etc.
 */
export const McpServerEntrySchema = z
  .object({
    /** The command to spawn the MCP server process. */
    command: z.string().min(1),
    /** Arguments passed to the command. */
    args: z.array(z.string()).optional(),
    /** Environment variables set for the spawned process. */
    env: z.record(z.string(), z.string()).optional(),
    /** Whether this MCP server is enabled. Defaults to true. */
    enabled: z.boolean().optional(),
    /** Connection timeout in milliseconds. Defaults to 30000. */
    timeout: z.number().int().min(1000).max(120000).optional(),
  })
  .strict();

/**
 * Extension policy configuration.
 */
export const ExtensionPolicySchema = z
  .object({
    /** How to handle capability mismatches: 'warn' emits diagnostics, 'enforce' disables the extension. */
    capabilities: z.enum(["warn", "enforce"]).default("warn"),
  })
  .strict();

/**
 * Top-level extensions configuration domain.
 */
export const ExtensionsConfigSchema = z
  .object({
    /** Master switch for the extension subsystem. */
    enabled: z.boolean().optional(),
    /** Allowlist of extension IDs. Empty array = allow none; omitted = allow all. */
    allow: z.array(z.string()).optional(),
    /** Denylist of extension IDs. Takes precedence over allow. */
    deny: z.array(z.string()).optional(),
    /** Directories and load options for extension discovery. */
    load: z
      .object({
        paths: z.array(z.string()).optional(),
      })
      .strict()
      .optional(),
    /** Per-extension entries keyed by extension ID. */
    entries: z.record(z.string(), ExtensionEntrySchema).optional(),
    /** Install records keyed by extension ID. */
    installs: z.record(z.string(), ExtensionInstallRecordSchema).optional(),
    /** MCP servers keyed by server ID. Standard MCP config format. */
    mcpServers: z.record(z.string(), McpServerEntrySchema).optional(),
    /** Policy settings for extension loading behavior. */
    policy: ExtensionPolicySchema.optional(),
  })
  .strict();

export type ExtensionsConfig = z.infer<typeof ExtensionsConfigSchema>;
export type ExtensionPolicyConfig = z.infer<typeof ExtensionPolicySchema>;
export type ExtensionEntryConfig = z.infer<typeof ExtensionEntrySchema>;
export type ExtensionInstallRecord = z.infer<typeof ExtensionInstallRecordSchema>;
export type McpServerEntry = z.infer<typeof McpServerEntrySchema>;
