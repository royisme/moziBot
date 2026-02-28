import type { MoziConfig } from "../../config/schema";
import type { AcpBridgeRuntimeAdapter } from "./runtime-adapter";
import { requireAcpRuntimeBackend } from "../runtime/registry";
import { readAcpSessionEntry, upsertAcpSessionMeta } from "../runtime/session-meta";

export type AcpBridgeRuntimeAdapterOptions = {
  config: MoziConfig;
  defaultSessionKey?: string;
  verbose?: boolean;
};

/**
 * Creates an ACP Bridge runtime adapter that connects to the moziBot runtime.
 */
export function createAcpBridgeRuntimeAdapter(
  options: AcpBridgeRuntimeAdapterOptions,
): AcpBridgeRuntimeAdapter {
  const { config, defaultSessionKey, verbose } = options;
  const log = verbose
    ? (msg: string) => process.stderr.write(`[acp-bridge] ${msg}\n`)
    : () => {};

  return {
    async *sendMessage(params) {
      const { sessionKey, text, attachments, signal } = params;

      log(`sendMessage: session=${sessionKey}, text=${text.substring(0, 50)}...`);

      // Get session metadata
      const sessionEntry = readAcpSessionEntry({ sessionKey });
      const meta = sessionEntry?.acp;

      if (!meta) {
        throw new Error(`Session "${sessionKey}" not found`);
      }

      // Get runtime backend
      const backend = requireAcpRuntimeBackend(meta.backend);

      // Get or create handle
      const handle = await ensureRuntimeHandle({
        sessionKey,
        meta,
        backend: backend.id,
      });

      // Run the turn
      const eventStream = backend.runtime.runTurn({
        handle,
        text,
        mode: "prompt",
        requestId: `acp:${Date.now()}`,
        signal,
      });

      // Map runtime events to bridge events
      for await (const event of eventStream) {
        if (event.type === "text_delta") {
          yield { type: "text_delta", text: event.text };
        } else if (event.type === "status") {
          log(`status: ${event.text}`);
        } else if (event.type === "tool_call") {
          yield {
            type: "tool_use",
            name: "tool",
            args: { description: event.text },
          };
        } else if (event.type === "done") {
          yield { type: "done", stopReason: event.stopReason };
          break;
        } else if (event.type === "error") {
          yield { type: "error", message: event.message };
          break;
        }
      }

      // Update session state to idle after completion
      upsertAcpSessionMeta({
        sessionKey,
        mutate: (current) => {
          if (!current) return null;
          return {
            ...current,
            state: "idle",
            lastActivityAt: Date.now(),
          };
        },
      });
    },

    async abortSession(sessionKey) {
      log(`abortSession: ${sessionKey}`);

      const sessionEntry = readAcpSessionEntry({ sessionKey });
      const meta = sessionEntry?.acp;

      if (!meta || !meta.identity?.agentSessionId) {
        log(`abortSession: no active run for ${sessionKey}`);
        return;
      }

      const backend = requireAcpRuntimeBackend(meta.backend);

      const handle = {
        sessionKey,
        backend: meta.backend,
        runtimeSessionName: meta.runtimeSessionName,
        cwd: meta.cwd,
        backendSessionId: meta.identity.acpxSessionId,
        agentSessionId: meta.identity.agentSessionId,
      };

      try {
        await backend.runtime.cancel({ handle, reason: "user-cancelled" });
        log(`abortSession: cancelled ${sessionKey}`);
      } catch (err) {
        log(`abortSession error: ${err instanceof Error ? err.message : String(err)}`);
      }
    },

    async resetSession(sessionKey) {
      log(`resetSession: ${sessionKey}`);

      const sessionEntry = readAcpSessionEntry({ sessionKey });
      const meta = sessionEntry?.acp;

      if (!meta) {
        log(`resetSession: session not found ${sessionKey}`);
        return;
      }

      // Clear identity to force recreation on next use
      upsertAcpSessionMeta({
        sessionKey,
        mutate: (current) => {
          if (!current) return null;
          return {
            ...current,
            identity: undefined,
            state: "idle",
            lastActivityAt: Date.now(),
          };
        },
      });

      log(`resetSession: cleared identity for ${sessionKey}`);
    },

    async resolveSessionKey(params) {
      const { key, label } = params;

      if (key) {
        return key;
      }

      if (label) {
        // Search sessions by label
        const { listAcpSessionEntries } = await import("../runtime/session-meta");
        const sessions = listAcpSessionEntries();

        for (const session of sessions) {
          const runtimeName = session.acp?.runtimeSessionName;
          if (runtimeName && runtimeName.toLowerCase() === label.toLowerCase()) {
            return session.sessionKey;
          }
        }
      }

      // Fall back to default
      return defaultSessionKey ?? null;
    },

    async listSessions() {
      const { listAcpSessionEntries } = await import("../runtime/session-meta");
      const sessions = listAcpSessionEntries();

      return sessions.map((session) => ({
        key: session.sessionKey,
        label: session.acp?.runtimeSessionName,
      }));
    },
  };
}

async function ensureRuntimeHandle(params: {
  sessionKey: string;
  meta: { backend: string; agent: string; runtimeSessionName: string; cwd?: string; identity?: { acpxSessionId?: string; agentSessionId?: string; acpxRecordId?: string } };
  backend: string;
}): Promise<{
  sessionKey: string;
  backend: string;
  runtimeSessionName: string;
  cwd?: string;
  backendSessionId?: string;
  agentSessionId?: string;
  acpxRecordId?: string;
}> {
  const { sessionKey, meta, backend } = params;

  // If we already have identity, return handle
  if (meta.identity?.agentSessionId) {
    return {
      sessionKey,
      backend: meta.backend,
      runtimeSessionName: meta.runtimeSessionName,
      cwd: meta.cwd,
      backendSessionId: meta.identity.acpxSessionId,
      agentSessionId: meta.identity.agentSessionId,
      acpxRecordId: meta.identity.acpxRecordId,
    };
  }

  // Need to ensure session in runtime
  const runtimeBackend = requireAcpRuntimeBackend(backend);

  const handle = await runtimeBackend.runtime.ensureSession({
    sessionKey,
    agent: meta.agent,
    mode: meta.mode,
    cwd: meta.cwd,
  });

  // Update identity
  const now = Date.now();
  upsertAcpSessionMeta({
    sessionKey,
    mutate: (current) => {
      if (!current) return null;
      return {
        ...current,
        identity: {
          state: "resolved",
          acpxRecordId: handle.acpxRecordId,
          acpxSessionId: handle.backendSessionId,
          agentSessionId: handle.agentSessionId,
          source: "ensure",
          lastUpdatedAt: now,
        },
      };
    },
  });

  return handle;
}
