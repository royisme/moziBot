import { spawn, type SpawnOptions } from "node:child_process";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";

export type AcpTransportType = "stdio" | "sse";

export type AcpTransportOptions = {
  type?: AcpTransportType;
  /** For stdio transport: command to spawn (e.g., "mozi", "node") */
  command?: string;
  /** For stdio transport: arguments to pass */
  args?: string[];
  /** For stdio transport: spawn options */
  spawnOptions?: SpawnOptions;
  /** For SSE transport: server URL */
  url?: string;
  /** Enable verbose logging */
  verbose?: boolean;
};

export type AcpTransportConnection = {
  connection: acp.ClientSideConnection;
  close: () => Promise<void>;
};

/**
 * Creates an ACP transport connection to the Bridge server.
 * Supports both stdio (subprocess) and SSE (HTTP) transports.
 */
export async function createAcpTransport(
  options: AcpTransportOptions = {},
): Promise<AcpTransportConnection> {
  const transportType = options.type ?? "stdio";
  const verbose = options.verbose ?? false;
  const log = verbose
    ? (msg: string) => process.stderr.write(`[acp-transport] ${msg}\n`)
    : () => {};

  if (transportType === "sse") {
    throw new Error("SSE transport not yet implemented. Use stdio transport.");
  }

  // stdio transport: spawn the bridge process
  const command = options.command ?? "mozi";
  const args = options.args ?? ["acp", "bridge"];
  const spawnOptions: SpawnOptions = {
    stdio: ["pipe", "pipe", "inherit"],
    ...options.spawnOptions,
  };

  log(`spawning bridge: ${command} ${args.join(" ")}`);

  const subprocess = spawn(command, args, spawnOptions);

  // Handle subprocess errors
  subprocess.on("error", (err) => {
    log(`subprocess error: ${err.message}`);
  });

  subprocess.on("exit", (code) => {
    log(`subprocess exited with code ${code}`);
  });

  if (!subprocess.stdin || !subprocess.stdout) {
    throw new Error("Failed to get stdin/stdout from subprocess");
  }

  const input = Writable.toWeb(subprocess.stdin);
  const output = Readable.toWeb(subprocess.stdout) as ReadableStream<Uint8Array>;
  const stream = acp.ndJsonStream(input, output);

  // Create a minimal client implementation
  const client: acp.Client = {
    async requestPermission(
      params: acp.RequestPermissionRequest,
    ): Promise<acp.RequestPermissionResponse> {
      log(`permission requested: ${params.toolCall.title}`);
      // Auto-approve for now; can be customized
      return {
        outcome: {
          outcome: "selected",
          optionId: "allow",
        },
      };
    },

    async sessionUpdate(params: acp.SessionNotification): Promise<void> {
      const update = params.update;
      switch (update.sessionUpdate) {
        case "agent_message_chunk":
          if (update.content.type === "text") {
            log(`agent message: ${update.content.text.substring(0, 50)}...`);
          }
          break;
        case "tool_call":
          log(`tool call: ${update.title} (${update.status})`);
          break;
        case "tool_call_update":
          log(`tool update: ${update.toolCallId} -> ${update.status}`);
          break;
        case "current_mode_update":
          log(`mode update: ${update.currentModeId}`);
          break;
      }
    },

    async readTextFile(params: acp.ReadTextFileRequest): Promise<acp.ReadTextFileResponse> {
      const fs = await import("node:fs/promises");
      const content = await fs.readFile(params.path, "utf-8");
      return { content };
    },

    async writeTextFile(params: acp.WriteTextFileRequest): Promise<acp.WriteTextFileResponse> {
      const fs = await import("node:fs/promises");
      await fs.writeFile(params.path, params.content);
      return {};
    },
  };

  const clientConnection = new acp.ClientSideConnection((_agent) => client, stream);

  // Initialize the connection
  const initResult = await clientConnection.initialize({
    protocolVersion: acp.PROTOCOL_VERSION,
    clientCapabilities: {
      fs: {
        readTextFile: true,
        writeTextFile: true,
      },
      terminal: true,
    },
  });

  log(`connected to bridge (protocol v${initResult.protocolVersion})`);

  return {
    connection: clientConnection,
    close: async () => {
      log("closing transport");
      subprocess.kill("SIGTERM");
      // Give subprocess time to clean up
      await new Promise((resolve) => setTimeout(resolve, 500));
    },
  };
}
