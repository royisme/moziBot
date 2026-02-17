import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { McpServerEntry } from "../../config/schema/extensions";
import type { ExtensionDiagnostic, LoadedExtension } from "../types";
import { logger } from "../../logger";

const DEFAULT_TIMEOUT = 30000;

type McpToolSchema = {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
};

type McpConnection = {
  id: string;
  client: Client;
  transport: StdioClientTransport;
  tools: AgentTool[];
};

/**
 * Manages MCP server connections.
 * Each configured MCP server is spawned as a child process, connected via stdio,
 * and its tools are discovered and adapted to AgentTool instances.
 */
export class McpClientManager {
  private connections = new Map<string, McpConnection>();

  /**
   * Connect to a single MCP server and discover its tools.
   * Returns a LoadedExtension representing this MCP server.
   */
  async connectServer(
    id: string,
    entry: McpServerEntry,
  ): Promise<{ extension: LoadedExtension; diagnostics: ExtensionDiagnostic[] }> {
    const diagnostics: ExtensionDiagnostic[] = [];
    const enabled = entry.enabled !== false;

    if (!enabled) {
      diagnostics.push({
        extensionId: `mcp:${id}`,
        level: "info",
        message: `MCP server "${id}" is disabled`,
      });
      return {
        extension: {
          manifest: {
            id: `mcp:${id}`,
            version: "0.0.0",
            name: `MCP: ${id}`,
            description: `MCP server (disabled)`,
            tools: [],
          },
          source: `mcp:${id}`,
          tools: [],
          hooks: [],
          commands: [],
          enabled: false,
          diagnostics,
        },
        diagnostics,
      };
    }

    const timeout = entry.timeout ?? DEFAULT_TIMEOUT;

    try {
      const env = entry.env ? { ...process.env, ...entry.env } : { ...process.env };
      const transport = new StdioClientTransport({
        command: entry.command,
        args: entry.args,
        env: env as Record<string, string>,
      });

      const client = new Client({
        name: "mozi",
        version: "1.0.0",
      });

      // Connect with timeout
      const connectPromise = client.connect(transport);
      const timeoutPromise = new Promise<never>((_resolve, reject) => {
        setTimeout(
          () => reject(new Error(`MCP server "${id}" connection timed out after ${timeout}ms`)),
          timeout,
        );
      });

      await Promise.race([connectPromise, timeoutPromise]);

      // Discover tools
      const toolsResponse = await client.listTools();
      const mcpTools = (toolsResponse.tools ?? []) as McpToolSchema[];

      logger.info(
        { mcpServerId: id, tools: mcpTools.map((t) => t.name) },
        `MCP server "${id}" connected with ${mcpTools.length} tool(s)`,
      );

      // Adapt MCP tools to AgentTool
      const agentTools: AgentTool[] = mcpTools.map((mcpTool) =>
        this.adaptMcpTool(id, client, mcpTool),
      );

      const connection: McpConnection = {
        id,
        client,
        transport,
        tools: agentTools,
      };
      this.connections.set(id, connection);

      const extension: LoadedExtension = {
        manifest: {
          id: `mcp:${id}`,
          version: "0.0.0",
          name: `MCP: ${id}`,
          description: `MCP server: ${entry.command} ${(entry.args ?? []).join(" ")}`,
          tools: mcpTools.map((t) => ({
            name: t.name,
            label: t.name,
            description: t.description ?? "",
            parameters: t.inputSchema ?? {},
            execute: async () => ({ content: [], details: {} }),
          })),
        },
        source: `mcp:${id}`,
        tools: agentTools,
        hooks: [],
        commands: [],
        enabled: true,
        diagnostics,
      };

      return { extension, diagnostics };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      diagnostics.push({
        extensionId: `mcp:${id}`,
        level: "error",
        message: `Failed to connect MCP server "${id}": ${message}`,
      });

      logger.warn({ mcpServerId: id, err: error }, `MCP server "${id}" failed to connect`);

      return {
        extension: {
          manifest: {
            id: `mcp:${id}`,
            version: "0.0.0",
            name: `MCP: ${id}`,
            description: `MCP server (failed)`,
            tools: [],
          },
          source: `mcp:${id}`,
          tools: [],
          hooks: [],
          commands: [],
          enabled: false,
          diagnostics,
        },
        diagnostics,
      };
    }
  }

  /**
   * Adapt an MCP tool definition into an AgentTool.
   */
  private adaptMcpTool(serverId: string, client: Client, mcpTool: McpToolSchema): AgentTool {
    return {
      name: mcpTool.name,
      label: mcpTool.name,
      description: mcpTool.description ?? `MCP tool from ${serverId}`,
      parameters: mcpTool.inputSchema ?? { type: "object", properties: {} },
      execute: async (_toolCallId: string, args: unknown) => {
        try {
          const result = await client.callTool({
            name: mcpTool.name,
            arguments: (args as Record<string, unknown>) ?? {},
          });

          // Extract text content from MCP result
          const textParts: string[] = [];
          if (Array.isArray(result.content)) {
            for (const item of result.content) {
              if (
                item &&
                typeof item === "object" &&
                "type" in item &&
                item.type === "text" &&
                "text" in item
              ) {
                textParts.push(String(item.text));
              }
            }
          }

          const text = textParts.length > 0 ? textParts.join("\n") : JSON.stringify(result);

          return {
            content: [{ type: "text", text }],
            details: {},
          };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return {
            content: [
              {
                type: "text",
                text: `MCP tool "${mcpTool.name}" (server: ${serverId}) failed: ${message}`,
              },
            ],
            details: {},
          };
        }
      },
    };
  }

  /**
   * Close a specific MCP server connection.
   */
  async closeServer(id: string): Promise<void> {
    const connection = this.connections.get(id);
    if (!connection) {
      return;
    }
    try {
      await connection.client.close();
    } catch (error) {
      logger.warn({ mcpServerId: id, err: error }, `Error closing MCP server "${id}"`);
    }
    this.connections.delete(id);
  }

  /**
   * Close all MCP server connections.
   */
  async closeAll(): Promise<void> {
    const ids = Array.from(this.connections.keys());
    await Promise.allSettled(ids.map((id) => this.closeServer(id)));
  }

  /**
   * Get the connection for a specific server.
   */
  getConnection(id: string): McpConnection | undefined {
    return this.connections.get(id);
  }

  /**
   * List all active connection IDs.
   */
  listConnections(): string[] {
    return Array.from(this.connections.keys());
  }
}
