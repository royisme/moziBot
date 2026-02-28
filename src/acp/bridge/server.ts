import { Readable, Writable } from "node:stream";
import { AgentSideConnection, ndJsonStream } from "@agentclientprotocol/sdk";
import type { AcpBridgeRuntimeAdapter } from "./runtime-adapter";
import { AcpGatewayAgent } from "./translator";
import type { AcpServerOptions } from "./types";

export type AcpBridgeOptions = AcpServerOptions & {
  adapter: AcpBridgeRuntimeAdapter;
};

/**
 * Starts the ACP Bridge server on stdin/stdout using NDJSON framing.
 *
 * The bridge translates ACP protocol messages from IDEs (Zed, VSCode) into
 * calls on the provided AcpBridgeRuntimeAdapter, which connects to the moziBot
 * agent runtime.
 *
 * Returns a promise that resolves when the connection is closed.
 */
export async function serveAcpBridge(opts: AcpBridgeOptions): Promise<void> {
  const { adapter, ...serverOpts } = opts;

  let onClosed!: () => void;
  const closed = new Promise<void>((resolve) => {
    onClosed = resolve;
  });

  let stopped = false;
  const shutdown = () => {
    if (stopped) {
      return;
    }
    stopped = true;
    onClosed();
  };

  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  // stdin is used as input (messages from IDE), stdout as output (messages to IDE)
  // Note: ndJsonStream(output, input) — output first, input second
  const output = Writable.toWeb(process.stdout);
  const input = Readable.toWeb(process.stdin) as unknown as ReadableStream<Uint8Array>;
  const stream = ndJsonStream(output, input);

  new AgentSideConnection((conn: AgentSideConnection) => {
    const agent = new AcpGatewayAgent(conn, adapter, serverOpts);
    agent.start();
    return agent;
  }, stream);

  return closed;
}
