import fs from "node:fs/promises";
import path from "node:path";

interface SendChannel {
  send(peerId: string, payload: { text: string }): Promise<unknown>;
}

interface HeartbeatLogger {
  warn(obj: Record<string, unknown>, msg: string): void;
}

function getHeartbeatFilePath(agentId: string, resolveWorkspaceDir: (agentId: string) => string | null): string | null {
  const workspaceDir = resolveWorkspaceDir(agentId);
  if (!workspaceDir) {
    return null;
  }
  return path.join(workspaceDir, "HEARTBEAT.md");
}

async function readHeartbeatEnabledDirective(
  agentId: string,
  resolveWorkspaceDir: (agentId: string) => string | null,
): Promise<boolean | null> {
  const filePath = getHeartbeatFilePath(agentId, resolveWorkspaceDir);
  if (!filePath) {
    return null;
  }
  let content = "";
  try {
    content = await fs.readFile(filePath, "utf-8");
  } catch {
    return null;
  }

  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    const matched = trimmed.match(/^@heartbeat\s+enabled\s*=\s*(on|off|true|false)$/i);
    if (!matched) {
      continue;
    }
    const value = matched[1]?.toLowerCase();
    return value === "on" || value === "true";
  }
  return null;
}

async function writeHeartbeatEnabledDirective(params: {
  agentId: string;
  enabled: boolean;
  resolveWorkspaceDir: (agentId: string) => string | null;
  logger: HeartbeatLogger;
  toError: (error: unknown) => Error;
}): Promise<boolean> {
  const { agentId, enabled, resolveWorkspaceDir, logger, toError } = params;
  const filePath = getHeartbeatFilePath(agentId, resolveWorkspaceDir);
  if (!filePath) {
    return false;
  }

  let content = "";
  try {
    content = await fs.readFile(filePath, "utf-8");
  } catch {
    content = "# HEARTBEAT.md\n\n";
  }

  const directiveLine = `@heartbeat enabled=${enabled ? "on" : "off"}`;
  const lines = content.split("\n");
  let replaced = false;
  const nextLines = lines.map((line) => {
    if (/^\s*@heartbeat\s+enabled\s*=\s*(on|off|true|false)\s*$/i.test(line)) {
      replaced = true;
      return directiveLine;
    }
    return line;
  });

  let nextContent = nextLines.join("\n");
  if (!replaced) {
    nextContent = `${directiveLine}\n${nextContent}`;
  }

  try {
    await fs.writeFile(filePath, nextContent, "utf-8");
    return true;
  } catch (error) {
    logger.warn(
      {
        agentId,
        filePath,
        error: toError(error).message,
      },
      "Failed to update HEARTBEAT.md directive",
    );
    return false;
  }
}

export async function handleHeartbeatCommand(params: {
  agentId: string;
  channel: SendChannel;
  peerId: string;
  args: string;
  resolveWorkspaceDir: (agentId: string) => string | null;
  logger: HeartbeatLogger;
  toError: (error: unknown) => Error;
}): Promise<void> {
  const { agentId, channel, peerId, args, resolveWorkspaceDir, logger, toError } = params;
  const action = args.trim().toLowerCase() || "status";
  const enabledDirective = await readHeartbeatEnabledDirective(agentId, resolveWorkspaceDir);
  const effectiveEnabled = enabledDirective ?? true;

  if (action === "status") {
    await channel.send(peerId, {
      text: `Heartbeat is currently ${effectiveEnabled ? "enabled" : "disabled"} for agent ${agentId}. (source: HEARTBEAT.md directive)`,
    });
    return;
  }

  if (action === "off" || action === "pause" || action === "stop" || action === "disable") {
    const ok = await writeHeartbeatEnabledDirective({
      agentId,
      enabled: false,
      resolveWorkspaceDir,
      logger,
      toError,
    });
    await channel.send(peerId, {
      text: ok
        ? `Heartbeat disabled for agent ${agentId} by updating HEARTBEAT.md.`
        : `Failed to update HEARTBEAT.md for agent ${agentId}.`,
    });
    return;
  }

  if (action === "on" || action === "resume" || action === "start" || action === "enable") {
    const ok = await writeHeartbeatEnabledDirective({
      agentId,
      enabled: true,
      resolveWorkspaceDir,
      logger,
      toError,
    });
    await channel.send(peerId, {
      text: ok
        ? `Heartbeat enabled for agent ${agentId} by updating HEARTBEAT.md.`
        : `Failed to update HEARTBEAT.md for agent ${agentId}.`,
    });
    return;
  }

  await channel.send(peerId, {
    text: "Usage: /heartbeat [status|on|off]",
  });
}
