import type { MoziConfig } from "../../../config";
import type { ChannelPlugin } from "../../adapters/channels/plugin";
import type { SecretScope } from "../../auth/types";
import { createRuntimeSecretBroker, type RuntimeSecretBroker } from "../../auth/broker";

function parseAuthScope(arg: string | undefined, agentId: string, config: MoziConfig): SecretScope {
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

export function parseMissingAuthKey(message: string): string | null {
  const marker = /AUTH_MISSING[:\s]+([A-Z0-9_]+)/i.exec(message);
  if (marker?.[1]) {
    return marker[1];
  }
  const simple = /missing auth(?:entication)?(?: secret| key)?[:\s]+([A-Z0-9_]+)/i.exec(message);
  if (simple?.[1]) {
    return simple[1];
  }
  return null;
}

export function isMissingAuthError(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes("auth_missing") ||
    lower.includes("missing auth") ||
    lower.includes("missing authentication")
  );
}

export async function handleAuthCommand(params: {
  args: string;
  agentId: string;
  senderId: string;
  channel: ChannelPlugin;
  peerId: string;
  config: MoziConfig;
  secretBroker: RuntimeSecretBroker;
  setSecretBroker: (broker: RuntimeSecretBroker) => void;
  toErrorMessage: (error: unknown) => string;
}): Promise<void> {
  const { args, agentId, senderId, channel, peerId, config, setSecretBroker, toErrorMessage } =
    params;
  if (config.runtime?.auth?.enabled !== true) {
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

    const scope = parseAuthScope(parsed.scopeArg, agentId, config);
    const masterKeyEnv = config.runtime?.auth?.masterKeyEnv ?? "MOZI_MASTER_KEY";
    const broker = createRuntimeSecretBroker({ masterKeyEnv });
    setSecretBroker(broker);

    if (parsed.command === "set") {
      if (!parsed.name || !parsed.value) {
        await channel.send(peerId, { text: "Usage: /setAuth set KEY=VALUE [--scope=...]" });
        return;
      }
      await broker.set({
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
      const removed = await broker.unset({ name: parsed.name, scope });
      await channel.send(peerId, {
        text: removed
          ? `Auth key '${parsed.name}' removed from scope ${formatScope(scope)}.`
          : `Auth key '${parsed.name}' not found in scope ${formatScope(scope)}.`,
      });
      return;
    }

    if (parsed.command === "list") {
      const list = await broker.list({ scope });
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
    const check = await broker.check({ name: parsed.name, agentId, scope });
    await channel.send(peerId, {
      text: check.exists
        ? `Auth key '${parsed.name}' exists (${formatScope(check.scope || scope)}).`
        : `Auth key '${parsed.name}' is missing. Set it with /setAuth set ${parsed.name}=<value> [--scope=...]`,
    });
  } catch (error) {
    await channel.send(peerId, {
      text: `Auth command failed: ${toErrorMessage(error)}`,
    });
  }
}
