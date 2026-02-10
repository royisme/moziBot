import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { McpClientManager } from "./mcp";
import type { ExtensionDiagnostic, ExtensionManifest, LoadedExtension } from "./types";

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
