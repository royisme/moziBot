export type ParsedCommand = {
  name:
    | "start"
    | "help"
    | "status"
    | "whoami"
    | "new"
    | "models"
    | "switch"
    | "stop"
    | "restart"
    | "compact"
    | "context"
    | "setauth"
    | "unsetauth"
    | "listauth"
    | "checkauth"
    | "reminders"
    | "heartbeat"
    | "think"
    | "reasoning";
  args: string;
};

export function parseCommand(text: string): ParsedCommand | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) {
    return null;
  }
  const token = trimmed.split(/\s+/, 1)[0] || "";
  const normalized = token.split("@", 1)[0].toLowerCase();
  const args = trimmed.slice(token.length).trim();
  if (
    normalized !== "/start" &&
    normalized !== "/help" &&
    normalized !== "/status" &&
    normalized !== "/whoami" &&
    normalized !== "/id" &&
    normalized !== "/new" &&
    normalized !== "/models" &&
    normalized !== "/switch" &&
    normalized !== "/model" &&
    normalized !== "/stop" &&
    normalized !== "/restart" &&
    normalized !== "/compact" &&
    normalized !== "/context" &&
    normalized !== "/setauth" &&
    normalized !== "/unsetauth" &&
    normalized !== "/listauth" &&
    normalized !== "/checkauth" &&
    normalized !== "/reminders" &&
    normalized !== "/heartbeat" &&
    normalized !== "/think" &&
    normalized !== "/thinking" &&
    normalized !== "/t" &&
    normalized !== "/reasoning" &&
    normalized !== "/reason"
  ) {
    return null;
  }
  let commandName = normalized.slice(1);
  if (commandName === "model") {
    commandName = "switch";
  }
  if (commandName === "id") {
    commandName = "whoami";
  }
  if (commandName === "thinking" || commandName === "t") {
    commandName = "think";
  }
  if (commandName === "reason") {
    commandName = "reasoning";
  }
  return {
    name: commandName as ParsedCommand["name"],
    args,
  };
}

export function normalizeImplicitControlCommand(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed || trimmed.startsWith("/")) {
    return null;
  }
  const compact = trimmed.replace(/\s+/g, "").toLowerCase();
  if (
    compact === "取消心跳" ||
    compact === "关闭心跳" ||
    compact === "停止心跳" ||
    compact === "暂停心跳" ||
    compact === "心跳关闭" ||
    compact === "心跳暂停" ||
    compact === "cancelheartbeat" ||
    compact === "stopheartbeat" ||
    compact === "disableheartbeat"
  ) {
    return "/heartbeat off";
  }
  if (
    compact === "开启心跳" ||
    compact === "恢复心跳" ||
    compact === "启动心跳" ||
    compact === "打开心跳" ||
    compact === "心跳开启" ||
    compact === "resumeheartbeat" ||
    compact === "startheartbeat" ||
    compact === "enableheartbeat"
  ) {
    return "/heartbeat on";
  }
  if (
    compact === "心跳状态" ||
    compact === "查看心跳" ||
    compact === "heartbeatstatus" ||
    compact === "statusheartbeat"
  ) {
    return "/heartbeat status";
  }
  return null;
}

export function parseDurationMs(input: string): number | null {
  const trimmed = input.trim().toLowerCase();
  if (!trimmed) {
    return null;
  }
  if (/^\d+$/.test(trimmed)) {
    return Number(trimmed);
  }
  const matched = trimmed.match(/^(\d+)(ms|s|m|h|d)$/);
  if (!matched) {
    return null;
  }
  const amount = Number(matched[1]);
  const unit = matched[2];
  if (unit === "ms") {
    return amount;
  }
  if (unit === "s") {
    return amount * 1000;
  }
  if (unit === "m") {
    return amount * 60_000;
  }
  if (unit === "h") {
    return amount * 3_600_000;
  }
  return amount * 86_400_000;
}

export function parseAtMs(input: string): number | null {
  const trimmed = input.trim();
  if (!trimmed) {
    return null;
  }
  if (/^\d+$/.test(trimmed)) {
    return Number(trimmed);
  }
  const parsed = Date.parse(trimmed);
  if (Number.isNaN(parsed)) {
    return null;
  }
  return parsed;
}
