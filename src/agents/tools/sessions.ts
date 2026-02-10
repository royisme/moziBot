import { z } from "zod";
import type { ContinuationRequest } from "../../runtime/core/contracts";
import type { SessionManager } from "../../runtime/host/sessions/manager";
import type { SpawnResult, SubAgentRegistry } from "../../runtime/host/sessions/spawn";
import type { Session } from "../../runtime/host/sessions/types";
import { continuationRegistry } from "../../runtime/core/continuation";
import { spawnSubAgent } from "../../runtime/host/sessions/spawn";

export interface SessionToolsContext {
  sessionManager: SessionManager;
  subAgentRegistry: SubAgentRegistry;
  currentSessionKey: string;
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
    const children = ctx.subAgentRegistry.listByParent(ctx.currentSessionKey);
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
});

export async function sessionsSpawn(
  ctx: SessionToolsContext,
  params: z.infer<typeof sessionsSpawnSchema>,
): Promise<SpawnResult> {
  return spawnSubAgent(ctx.sessionManager, ctx.subAgentRegistry, {
    parentKey: ctx.currentSessionKey,
    agentId: params.agentId,
    model: params.model,
    task: params.task,
    label: params.label,
    cleanup: params.cleanup || "keep",
    timeoutSeconds: params.runTimeoutSeconds,
  });
}

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
  const request: ContinuationRequest = {
    prompt: params.prompt,
    delayMs: params.delayMs,
    reason: params.reason,
    context: params.context,
  };

  continuationRegistry.schedule(ctx.currentSessionKey, request);

  return {
    scheduled: true,
    message: params.delayMs
      ? `Continuation scheduled with ${params.delayMs}ms delay`
      : "Continuation scheduled to run immediately after current response",
  };
}
