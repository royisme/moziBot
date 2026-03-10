import { z } from "zod";
import { AcpSessionManager } from "../../acp/control-plane";
import {
  normalizeRuntimeOptions,
  validateRuntimeOptionPatch,
} from "../../acp/control-plane/runtime-options";
import { upsertAcpSessionMeta } from "../../acp/runtime/session-meta";
import type { SessionAcpMeta } from "../../acp/types";
import type { MoziConfig } from "../../config/schema";
import { isAcpDispatchEnabledByPolicy, isAcpEnabledByPolicy } from "../../config/schema/acp-policy";
import { continuationRegistry } from "../../runtime/core/continuation";
import type { ContinuationRequest } from "../../runtime/core/contracts";
import type { SessionManager } from "../../runtime/host/sessions/manager";
import type { SpawnResult, DetachedRunRegistry } from "../../runtime/host/sessions/spawn";
import { spawnSubAgent } from "../../runtime/host/sessions/spawn";
import type { Session } from "../../runtime/host/sessions/types";
import { resolveAgentJobEscalationTarget } from "../../runtime/jobs/policy";
import { sessionsStatus, sessionsStatusDescription, sessionsStatusSchema } from "./sessions-status";

export interface SessionToolsContext {
  sessionManager: SessionManager;
  detachedRunRegistry: DetachedRunRegistry;
  currentSessionKey: string;
  config?: MoziConfig;
}

export interface SessionInfo {
  key: string;
  agentId: string;
  channel: string;
  status: string;
  lastActiveAt: string;
  parentKey?: string;
}

export interface Message {
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  timestamp: string;
  toolCallId?: string;
  name?: string;
}

const acpSpawnSchema = z
  .object({
    backend: z.string().optional(),
    agent: z.string().optional(),
    mode: z.enum(["persistent", "oneshot"]).optional(),
    runtimeMode: z.string().optional(),
    model: z.string().optional(),
    cwd: z.string().optional(),
    permissionProfile: z.string().optional(),
    timeoutSeconds: z.number().optional(),
  })
  .optional();

// sessions_list - List active sessions
export const sessionsListSchema = z.object({
  agentId: z.string().optional(),
  channel: z.string().optional(),
  status: z
    .enum(["idle", "queued", "running", "retrying", "completed", "failed", "interrupted"])
    .optional(),
  limit: z.number().optional(),
});

export async function sessionsList(
  ctx: SessionToolsContext,
  params: z.infer<typeof sessionsListSchema>,
): Promise<{ sessions: SessionInfo[] }> {
  const sessions = ctx.sessionManager.list(params);
  const limit = params.limit || sessions.length;

  return {
    sessions: sessions.slice(0, limit).map((s: Session) => ({
      key: s.key,
      agentId: s.agentId,
      channel: s.channel,
      status: s.status,
      lastActiveAt: s.lastActiveAt.toISOString(),
      parentKey: s.parentKey,
    })),
  };
}

// sessions_history - Get message history for a session
export const sessionsHistorySchema = z.object({
  sessionKey: z.string(),
  limit: z.number().optional(),
  includeTools: z.boolean().optional(),
});

export async function sessionsHistory(
  _ctx: SessionToolsContext,
  _params: z.infer<typeof sessionsHistorySchema>,
): Promise<{ messages: Message[] }> {
  // For now, returns empty (actual history will come from transcript files later)
  return { messages: [] };
}

// sessions_send - Send a message to another session
export const sessionsSendSchema = z.object({
  sessionKey: z.string().optional(),
  label: z.string().optional(),
  message: z.string(),
  timeoutSeconds: z.number().optional(),
});

export async function sessionsSend(
  ctx: SessionToolsContext,
  params: z.infer<typeof sessionsSendSchema>,
): Promise<{ status: string; delivered: boolean }> {
  // For sessions_send, just update the target session's status for now
  // (actual message delivery comes later)

  let targetKey = params.sessionKey;

  if (!targetKey && params.label) {
    const children = ctx.detachedRunRegistry.listByParent(ctx.currentSessionKey);
    const found = children.find((c) => c.label === params.label);
    if (found) {
      targetKey = found.childKey;
    }
  }

  if (targetKey) {
    const session = ctx.sessionManager.get(targetKey);
    if (session) {
      await ctx.sessionManager.setStatus(targetKey, "queued");
      return { status: "sent", delivered: true };
    }
  }

  return { status: "failed", delivered: false };
}

// sessions_spawn - Spawn a sub-agent (wrapper around spawnSubAgent)
export const sessionsSpawnSchema = z.object({
  task: z.string(),
  agentId: z.string().optional(),
  model: z.string().optional(),
  label: z.string().optional(),
  cleanup: z.enum(["delete", "keep"]).optional(),
  runTimeoutSeconds: z.number().optional(),
  runtime: z.enum(["default", "acp"]).optional(),
  acp: acpSpawnSchema,
});

function shouldUseAcpSpawn(params: z.infer<typeof sessionsSpawnSchema>): boolean {
  return params.runtime === "acp" || Boolean(params.acp);
}

async function initializeAcpSubAgent(
  ctx: SessionToolsContext,
  params: z.infer<typeof sessionsSpawnSchema>,
  spawnResult: SpawnResult,
): Promise<SpawnResult> {
  const config = ctx.config;
  if (config) {
    if (!isAcpEnabledByPolicy(config)) {
      return {
        runId: spawnResult.runId,
        childKey: "",
        sessionId: "",
        status: "rejected",
        error: "ACP is disabled by policy.",
      };
    }
    if (!isAcpDispatchEnabledByPolicy(config)) {
      return {
        runId: spawnResult.runId,
        childKey: "",
        sessionId: "",
        status: "rejected",
        error: "ACP dispatch is disabled by policy.",
      };
    }
  }

  const childKey = spawnResult.childKey;
  const childSession = ctx.sessionManager.get(childKey);
  if (!childSession) {
    return {
      runId: spawnResult.runId,
      childKey: "",
      sessionId: "",
      status: "error",
      error: "Spawned child session was not found",
    };
  }

  const acpOptions = params.acp ?? {};
  const resolvedBackend = acpOptions.backend?.trim() || config?.acp?.backend?.trim();
  if (!resolvedBackend) {
    return {
      runId: spawnResult.runId,
      childKey: "",
      sessionId: "",
      status: "rejected",
      error: "ACP backend is required (set acp.backend or pass acp.backend).",
    };
  }

  const resolvedAgent =
    acpOptions.agent?.trim() || params.agentId?.trim() || childSession.agentId || "main";
  const mode = acpOptions.mode ?? "persistent";

  const runtimeOptionsPatch = validateRuntimeOptionPatch({
    model: acpOptions.model ?? params.model,
    runtimeMode: acpOptions.runtimeMode,
    cwd: acpOptions.cwd,
    permissionProfile: acpOptions.permissionProfile,
    timeoutSeconds: acpOptions.timeoutSeconds ?? params.runTimeoutSeconds,
  });
  const runtimeOptions = normalizeRuntimeOptions(runtimeOptionsPatch);

  const now = Date.now();
  const meta: SessionAcpMeta = {
    backend: resolvedBackend,
    agent: resolvedAgent,
    runtimeSessionName: childKey,
    mode,
    ...(Object.keys(runtimeOptions).length > 0 ? { runtimeOptions } : {}),
    ...(runtimeOptions.cwd ? { cwd: runtimeOptions.cwd } : {}),
    state: "idle",
    lastActivityAt: now,
  };

  try {
    upsertAcpSessionMeta({
      sessionKey: childKey,
      mutate: () => meta,
    });

    const acpSessionManager = new AcpSessionManager();
    await acpSessionManager.ensureSession({
      cfg: config ?? {},
      sessionKey: childKey,
      agent: resolvedAgent,
      mode,
      cwd: runtimeOptions.cwd,
      backendId: resolvedBackend,
    });

    await ctx.sessionManager.update(childKey, {
      metadata: {
        ...childSession.metadata,
        acp: {
          backend: resolvedBackend,
          mode,
          ...(Object.keys(runtimeOptions).length > 0 ? { runtimeOptions } : {}),
        },
      },
    });

    return spawnResult;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);

    try {
      upsertAcpSessionMeta({
        sessionKey: childKey,
        mutate: () => null,
      });
    } catch {
      // best-effort cleanup
    }

    await ctx.detachedRunRegistry.completeByChildKey(childKey, {
      status: "failed",
      error: message,
    });
    await ctx.sessionManager.setStatus(childKey, "failed");

    return {
      runId: spawnResult.runId,
      childKey,
      sessionId: spawnResult.sessionId,
      status: "error",
      error: message,
    };
  }
}

export async function sessionsSpawn(
  ctx: SessionToolsContext,
  params: z.infer<typeof sessionsSpawnSchema>,
): Promise<SpawnResult> {
  const spawnResult = await spawnSubAgent(ctx.sessionManager, ctx.detachedRunRegistry, {
    parentKey: ctx.currentSessionKey,
    agentId: params.agentId,
    model: params.model,
    task: params.task,
    label: params.label,
    cleanup: params.cleanup || "keep",
    timeoutSeconds: params.runTimeoutSeconds,
  });

  if (spawnResult.status !== "accepted") {
    return spawnResult;
  }

  if (!shouldUseAcpSpawn(params)) {
    return spawnResult;
  }

  return initializeAcpSubAgent(ctx, params, spawnResult);
}

export const subagentStatusSchema = sessionsStatusSchema;

export async function subagentStatus(
  ctx: SessionToolsContext,
  params: z.infer<typeof subagentStatusSchema>,
) {
  return await sessionsStatus(ctx.detachedRunRegistry, params);
}

export const subagentListSchema = sessionsStatusSchema;

export async function subagentList(
  ctx: SessionToolsContext,
  params: z.infer<typeof subagentListSchema>,
) {
  return await sessionsStatus(ctx.detachedRunRegistry, params);
}

export const subagentStatusDescription = sessionsStatusDescription;
export const subagentListDescription = sessionsStatusDescription;

export const scheduleContinuationSchema = z.object({
  prompt: z.string().min(1),
  delayMs: z.number().optional(),
  reason: z.string().optional(),
  context: z.record(z.string(), z.unknown()).optional(),
});

export async function scheduleContinuation(
  ctx: SessionToolsContext,
  params: z.infer<typeof scheduleContinuationSchema>,
): Promise<{ scheduled: boolean; message: string }> {
  const heartbeatPattern = /(\bheartbeat\b|心跳)/i;
  const combinedHint = `${params.reason || ""}\n${params.prompt}`;
  if (heartbeatPattern.test(combinedHint) && (params.delayMs ?? 0) > 0) {
    return {
      scheduled: false,
      message:
        "Rejected: periodic heartbeat scheduling via schedule_continuation is not allowed. Manage heartbeat cadence in HEARTBEAT.md directives (@heartbeat every=..., @heartbeat enabled=...) or use reminder_create for durable timers.",
    };
  }

  const target = resolveAgentJobEscalationTarget({
    source: "continuation",
    expectedDelayMs: params.delayMs,
    longTaskThresholdMs: ctx.config?.runtime?.agentJobs?.longTaskThresholdMs,
  });
  if (target !== "job") {
    throw new Error("Queued continuation must escalate to AgentJob");
  }

  const request: ContinuationRequest = {
    prompt: params.prompt,
    delayMs: params.delayMs,
    reason: params.reason,
    context: {
      ...params.context,
      escalationTarget: "job",
    },
  };

  const accepted = continuationRegistry.schedule(ctx.currentSessionKey, request);
  if (!accepted) {
    return {
      scheduled: false,
      message:
        "Continuation scheduling is currently blocked for this session (likely due to /stop cancellation). Send a new request to resume normal scheduling.",
    };
  }

  return {
    scheduled: true,
    message: params.delayMs
      ? `Continuation scheduled with ${params.delayMs}ms delay`
      : "Continuation scheduled to run immediately after current response",
  };
}
