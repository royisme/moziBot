import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { McpClientManager } from "./mcp";
import type {
  ExtensionCommandContext,
  ExtensionCommandDefinition,
  ExtensionDiagnostic,
  ExtensionHookDefinition,
  ExtensionManifest,
  LoadedExtension,
} from "./types";

type ResolvedExtensionCommand = {
  extensionId: string;
  source: string;
  command: ExtensionCommandDefinition;
};

type ResolvedExtensionHook = {
  extensionId: string;
  source: string;
  hook: ExtensionHookDefinition;
};

/**
 * ExtensionRegistry holds all loaded extensions and provides
 * unified access to their tools, skill dirs, and diagnostics.
 */
export class ExtensionRegistry {
  private extensions = new Map<string, LoadedExtension>();
  private allDiagnostics: ExtensionDiagnostic[] = [];
  private mcpManager?: McpClientManager;

  /** Register a loaded extension. Overwrites any prior registration with the same ID. */
  register(ext: LoadedExtension): void {
    this.extensions.set(ext.manifest.id, ext);
  }

  /** Add diagnostics (e.g. from discovery/loading phases). */
  addDiagnostics(diagnostics: ExtensionDiagnostic[]): void {
    this.allDiagnostics.push(...diagnostics);
  }

  /** Set the MCP client manager for lifecycle management. */
  setMcpManager(manager: McpClientManager): void {
    this.mcpManager = manager;
  }

  /** Get the MCP client manager (if any). */
  getMcpManager(): McpClientManager | undefined {
    return this.mcpManager;
  }

  /** Get a specific loaded extension by ID. */
  get(id: string): LoadedExtension | undefined {
    return this.extensions.get(id);
  }

  /** List all registered extensions. */
  list(): LoadedExtension[] {
    return Array.from(this.extensions.values());
  }

  /** List only enabled extensions. */
  listEnabled(): LoadedExtension[] {
    return this.list().filter((ext) => ext.enabled);
  }

  /** Collect all AgentTool instances from enabled extensions. */
  collectTools(): AgentTool[] {
    const tools: AgentTool[] = [];
    for (const ext of this.listEnabled()) {
      tools.push(...ext.tools);
    }
    return tools;
  }

  /** Collect all runtime hooks from enabled extensions. */
  collectHooks(): ResolvedExtensionHook[] {
    const hooks: ResolvedExtensionHook[] = [];
    for (const ext of this.listEnabled()) {
      for (const hook of ext.hooks) {
        hooks.push({
          extensionId: ext.manifest.id,
          source: ext.source,
          hook,
        });
      }
    }
    return hooks;
  }

  /** Collect all skill directories from enabled extensions. */
  collectSkillDirs(): string[] {
    const dirs: string[] = [];
    for (const ext of this.listEnabled()) {
      if (ext.manifest.skillDirs) {
        dirs.push(...ext.manifest.skillDirs);
      }
    }
    return dirs;
  }

  /** Get all manifests (enabled or not). */
  listManifests(): ExtensionManifest[] {
    return this.list().map((ext) => ext.manifest);
  }

  /** List all command registrations from enabled extensions. */
  listCommands(): ResolvedExtensionCommand[] {
    const commands: ResolvedExtensionCommand[] = [];
    for (const ext of this.listEnabled()) {
      for (const command of ext.commands) {
        commands.push({
          extensionId: ext.manifest.id,
          source: ext.source,
          command,
        });
      }
    }
    return commands;
  }

  findCommand(commandName: string): ResolvedExtensionCommand | undefined {
    const normalized = commandName.trim().replace(/^\/+/, "").toLowerCase();
    if (!normalized) {
      return undefined;
    }
    return this.listCommands().find((entry) => entry.command.name === normalized);
  }

  async executeCommand(params: {
    commandName: string;
    args: string;
    sessionKey: string;
    agentId: string;
    peerId: string;
    channelId: string;
    message: unknown;
    sendReply: (text: string) => Promise<void>;
    onError?: (error: unknown, meta: { extensionId: string; commandName: string }) => void;
  }): Promise<boolean> {
    const matched = this.findCommand(params.commandName);
    if (!matched) {
      return false;
    }

    if (params.args.trim().length > 0 && matched.command.acceptsArgs === false) {
      return false;
    }

    try {
      const context: ExtensionCommandContext = {
        sessionKey: params.sessionKey,
        agentId: params.agentId,
        peerId: params.peerId,
        channelId: params.channelId,
        args: params.args,
        message: params.message,
        sendReply: params.sendReply,
      };
      const result = await matched.command.handler(context);
      if (result?.text && result.text.trim()) {
        await params.sendReply(result.text.trim());
      }
      return true;
    } catch (error) {
      params.onError?.(error, {
        extensionId: matched.extensionId,
        commandName: matched.command.name,
      });
      await params.sendReply("Command failed. Please try again later.");
      return true;
    }
  }

  /** Get all diagnostics accumulated across loading and registration. */
  getDiagnostics(): ExtensionDiagnostic[] {
    const perExt = this.list().flatMap((ext) => ext.diagnostics);
    return [...this.allDiagnostics, ...perExt];
  }

  /** Close all MCP connections and clear state. */
  async shutdown(): Promise<void> {
    if (this.mcpManager) {
      await this.mcpManager.closeAll();
    }
  }

  /** Clear all registered extensions and diagnostics. */
  clear(): void {
    this.extensions.clear();
    this.allDiagnostics = [];
  }
}
