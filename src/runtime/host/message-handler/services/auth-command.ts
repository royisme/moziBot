import { createRuntimeSecretBroker } from "../../../auth/broker";
import type { SecretScope } from "../../../auth/types";
import type { MoziConfig } from "../../../../config";

interface SendChannel {
  send(peerId: string, payload: { text: string }): Promise<unknown>;
}

function isAuthEnabled(config: MoziConfig): boolean {
  return config.runtime?.auth?.enabled === true;
}

function parseAuthScope(config: MoziConfig, arg: string | undefined, agentId: string): SecretScope {
  const raw = (arg || "").trim();
  if (!raw) {
    const defaultScope = config.runtime?.auth?.defaultScope ?? "agent";
    if (defaultScope === "global") {
      return { type: "global" };
    }
    return { type: "agent", agentId };
  }
  if (raw === "global") {
    return { type: "global" };
  }
  if (raw === "agent") {
    return { type: "agent", agentId };
  }
  if (raw.startsWith("agent:")) {
    const explicitAgent = raw.slice("agent:".length).trim();
    return { type: "agent", agentId: explicitAgent || agentId };
  }
  return { type: "agent", agentId };
}

function formatScope(scope: SecretScope): string {
  if (scope.type === "global") {
    return "global";
  }
  return `agent:${scope.agentId}`;
}

function parseAuthArgs(args: string): {
  command: "set" | "unset" | "list" | "check";
  name?: string;
  value?: string;
  scopeArg?: string;
} | null {
  const trimmed = args.trim();
  if (!trimmed) {
    return null;
  }
  const parts = trimmed.split(/\s+/);
  const sub = parts[0]?.toLowerCase();
  const scopeArg = parts.find((p) => p.startsWith("--scope="))?.slice("--scope=".length);
  if (sub === "set") {
    const keyValue = parts.find((p, i) => i > 0 && p.includes("="));
    if (!keyValue) {
      return { command: "set", scopeArg };
    }
    const idx = keyValue.indexOf("=");
    const name = keyValue.slice(0, idx).trim();
    const value = keyValue.slice(idx + 1);
    return { command: "set", name, value, scopeArg };
  }
  if (sub === "unset") {
    return { command: "unset", name: parts[1], scopeArg };
  }
  if (sub === "list") {
    return { command: "list", scopeArg };
  }
  if (sub === "check") {
    return { command: "check", name: parts[1], scopeArg };
  }
  return null;
}

export async function handleAuthCommand(params: {
  args: string;
  agentId: string;
  senderId: string;
  channel: SendChannel;
  peerId: string;
  config: MoziConfig;
  toError: (error: unknown) => Error;
}): Promise<void> {
  const { args, agentId, senderId, channel, peerId, config, toError } = params;
  if (!isAuthEnabled(config)) {
    await channel.send(peerId, {
      text: "Auth broker is disabled. Set runtime.auth.enabled=true in config to use /setAuth commands.",
    });
    return;
  }
  try {
    const parsed = parseAuthArgs(args);
    if (!parsed) {
      await channel.send(peerId, {
        text: "Usage:\n/setAuth set KEY=VALUE [--scope=agent|global|agent:<id>]\n/unsetAuth KEY [--scope=agent|global|agent:<id>]\n/listAuth [--scope=agent|global|agent:<id>]\n/checkAuth KEY [--scope=agent|global|agent:<id>]",
      });
      return;
    }

    const scope = parseAuthScope(config, parsed.scopeArg, agentId);
    const masterKeyEnv = config.runtime?.auth?.masterKeyEnv ?? "MOZI_MASTER_KEY";
    const secretBroker = createRuntimeSecretBroker({ masterKeyEnv });

    if (parsed.command === "set") {
      if (!parsed.name || !parsed.value) {
        await channel.send(peerId, { text: "Usage: /setAuth set KEY=VALUE [--scope=...]" });
        return;
      }
      await secretBroker.set({
        name: parsed.name,
        value: parsed.value,
        scope,
        actor: senderId,
      });
      await channel.send(peerId, {
        text: `Auth key '${parsed.name}' stored for scope ${formatScope(scope)}.`,
      });
      return;
    }

    if (parsed.command === "unset") {
      if (!parsed.name) {
        await channel.send(peerId, { text: "Usage: /unsetAuth KEY [--scope=...]" });
        return;
      }
      const removed = await secretBroker.unset({ name: parsed.name, scope });
      await channel.send(peerId, {
        text: removed
          ? `Auth key '${parsed.name}' removed from scope ${formatScope(scope)}.`
          : `Auth key '${parsed.name}' not found in scope ${formatScope(scope)}.`,
      });
      return;
    }

    if (parsed.command === "list") {
      const list = await secretBroker.list({ scope });
      if (list.length === 0) {
        await channel.send(peerId, {
          text: `No auth keys stored in scope ${formatScope(scope)}.`,
        });
        return;
      }
      const lines = ["Auth keys:"];
      for (const item of list) {
        lines.push(
          `- ${item.name} (${formatScope(item.scope)}) updated=${item.updatedAt}${item.lastUsedAt ? ` lastUsed=${item.lastUsedAt}` : ""}`,
        );
      }
      await channel.send(peerId, { text: lines.join("\n") });
      return;
    }

    if (!parsed.name) {
      await channel.send(peerId, { text: "Usage: /checkAuth KEY [--scope=...]" });
      return;
    }
    const check = await secretBroker.check({ name: parsed.name, agentId, scope });
    await channel.send(peerId, {
      text: check.exists
        ? `Auth key '${parsed.name}' exists (${formatScope(check.scope || scope)}).`
        : `Auth key '${parsed.name}' is missing. Set it with /setAuth set ${parsed.name}=<value> [--scope=...]`,
    });
  } catch (error) {
    await channel.send(peerId, {
      text: `Auth command failed: ${toError(error).message}`,
    });
  }
}
