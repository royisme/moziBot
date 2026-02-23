import type { MoziConfig } from "../../../../config";

export type SessionType = "direct" | "group" | "thread";
export type SessionResetMode = "daily" | "idle" | "disabled";

export interface SessionResetPolicyInput {
  mode?: SessionResetMode;
  atHour?: number;
  idleMinutes?: number;
}

export interface ResolvedSessionResetPolicy {
  mode: SessionResetMode;
  atHour: number;
  idleMinutes?: number;
}

export function resolveSessionType(params: {
  peerType?: string;
  threadId?: unknown;
}): SessionType {
  if (params.threadId !== undefined && params.threadId !== null && params.threadId !== "") {
    return "thread";
  }
  if (params.peerType === "dm") {
    return "direct";
  }
  return "group";
}

function selectPolicy(params: {
  base?: SessionResetPolicyInput;
  byType?: Record<string, SessionResetPolicyInput | undefined>;
  byChannel?: Record<string, SessionResetPolicyInput | undefined>;
  sessionType: SessionType;
  channelId?: string;
}): SessionResetPolicyInput | undefined {
  const { base, byType, byChannel, sessionType, channelId } = params;
  if (channelId && byChannel?.[channelId]) {
    return byChannel[channelId];
  }
  if (byType?.[sessionType]) {
    return byType[sessionType];
  }
  return base;
}

export function resolveSessionResetPolicy(params: {
  config: MoziConfig;
  sessionType: SessionType;
  channelId?: string;
}): ResolvedSessionResetPolicy | null {
  const sessionCfg = params.config.session as
    | {
        reset?: SessionResetPolicyInput;
        resetByType?: Record<string, SessionResetPolicyInput | undefined>;
        resetByChannel?: Record<string, SessionResetPolicyInput | undefined>;
      }
    | undefined;

  if (!sessionCfg) {
    return null;
  }

  const selected = selectPolicy({
    base: sessionCfg.reset,
    byType: sessionCfg.resetByType,
    byChannel: sessionCfg.resetByChannel,
    sessionType: params.sessionType,
    channelId: params.channelId,
  });

  if (!selected) {
    return null;
  }

  const mode = selected.mode ?? "daily";
  const atHour = Number.isFinite(selected.atHour) ? (selected.atHour as number) : 4;

  return {
    mode,
    atHour,
    idleMinutes: selected.idleMinutes,
  };
}

export function computeDailyResetBoundaryMs(nowMs: number, atHour: number): number {
  const now = new Date(nowMs);
  const boundary = new Date(now);
  boundary.setHours(atHour, 0, 0, 0);
  if (now.getTime() < boundary.getTime()) {
    boundary.setDate(boundary.getDate() - 1);
  }
  return boundary.getTime();
}

export function shouldRotateSessionForResetPolicy(
  policy: ResolvedSessionResetPolicy,
  session: { createdAt: number; updatedAt?: number },
  nowMs: number = Date.now(),
): boolean {
  if (policy.mode === "disabled") {
    return false;
  }

  const lastActivityMs = session.updatedAt || session.createdAt;
  const idleMinutes = policy.idleMinutes ?? 0;
  const idleExpired =
    idleMinutes > 0 ? nowMs - lastActivityMs > idleMinutes * 60 * 1000 : false;

  if (policy.mode === "idle") {
    return idleExpired;
  }

  const boundaryMs = computeDailyResetBoundaryMs(nowMs, policy.atHour);
  const dailyExpired = lastActivityMs < boundaryMs;

  if (idleMinutes > 0) {
    return dailyExpired || idleExpired;
  }
  return dailyExpired;
}
