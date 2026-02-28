import { z } from "zod";
import type { MoziConfig } from "../../config/schema";
import { isAcpDispatchEnabledByPolicy, isAcpEnabledByPolicy } from "../../config/schema/acp-policy";
import { AcpSessionManager } from "../../acp/control-plane";
import { normalizeRuntimeOptions, validateRuntimeOptionPatch } from "../../acp/control-plane/runtime-options";
import type { SessionAcpMeta } from "../../acp/types";
import { upsertAcpSessionMeta } from "../../acp/runtime/session-meta";
import type { SpawnResult, SubAgentRegistry } from "../../runtime/host/sessions/spawn";
import type { SessionManager } from "../../runtime/host/sessions/manager";
import type { Session } from "../../runtime/host/sessions/types";

/**
 * ACP spawn options schema
 */
export const acpSpawnSchema = z
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

/**
 * Extended sessions_spawn schema with ACP support
 */
export const sessionsAcpSpawnSchema = z.object({
  task: z.string(),
  agentId: z.string().optional(),
  model: z.string().optional(),
  label: z.string().optional(),
  cleanup: z.enum(["delete", "keep"]).optional(),
  runTimeoutSeconds: z.number().optional(),
  runtime: z.literal("acp").optional(),
  acp: acpSpawnSchema,
});

/**
 * Parameters for spawning an ACP sub-agent
 */
export type SessionsAcpSpawnParams = z.infer<typeof sessionsAcpSpawnSchema>;

/**
 * Determines if the spawn should use ACP backend
 */
export function shouldUseAcpSpawn(params: SessionsAcpSpawnParams): boolean {
  return params.runtime === "acp" || Boolean(params.acp);
}

/**
 * Context interface for ACP spawn operations
 */
export interface SessionAcpToolsContext {
  sessionManager: SessionManager;
  subAgentRegistry: SubAgentRegistry;
  currentSessionKey: string;
  config?: MoziConfig;
}

/**
 * Initialize an ACP sub-agent session
 *
 * This function:
 * 1. Validates ACP policy
 * 2. Creates ACP session metadata
 * 3. Ensures the ACP session is initialized via AcpSessionManager
 * 4. Updates the session with ACP metadata
 */
export async function initializeAcpSubAgent(
  ctx: SessionAcpToolsContext,
  params: SessionsAcpSpawnParams,
  spawnResult: SpawnResult,
): Promise<SpawnResult> {
  const config = ctx.config;

  // Validate ACP policy
  if (config) {
    if (!isAcpEnabledByPolicy(config)) {
      return {
        childKey: "",
        sessionId: "",
        status: "rejected",
        error: "ACP is disabled by policy.",
      };
    }
    if (!isAcpDispatchEnabledByPolicy(config)) {
      return {
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
      childKey: "",
      sessionId: "",
      status: "error",
      error: "Spawned child session was not found",
    };
  }

  // Resolve ACP options
  const acpOptions = params.acp ?? {};
  const resolvedBackend = acpOptions.backend?.trim() || config?.acp?.backend?.trim();

  if (!resolvedBackend) {
    return {
      childKey: "",
      sessionId: "",
      status: "rejected",
      error: "ACP backend is required (set acp.backend or pass acp.backend).",
    };
  }

  const resolvedAgent =
    acpOptions.agent?.trim() || params.agentId?.trim() || childSession.agentId || "main";
  const mode = acpOptions.mode ?? "persistent";

  // Normalize runtime options
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
    // Upsert ACP session metadata
    upsertAcpSessionMeta({
      sessionKey: childKey,
      mutate: () => meta,
    });

    // Ensure the ACP session is initialized
    const acpSessionManager = new AcpSessionManager();
    await acpSessionManager.ensureSession({
      cfg: (config ?? {}) as MoziConfig,
      sessionKey: childKey,
      agent: resolvedAgent,
      mode,
      cwd: runtimeOptions.cwd,
      backendId: resolvedBackend,
    });

    // Update session with ACP metadata
    await ctx.sessionManager.update(childKey, {
      metadata: {
        ...(childSession.metadata ?? {}),
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

    // Best-effort cleanup of meta
    try {
      upsertAcpSessionMeta({
        sessionKey: childKey,
        mutate: () => null,
      });
    } catch {
      // Ignore cleanup errors
    }

    // Mark sub-agent as failed
    ctx.subAgentRegistry.complete(childKey, {
      status: "failed",
      error: message,
    });
    await ctx.sessionManager.setStatus(childKey, "failed");

    return {
      childKey,
      sessionId: spawnResult.sessionId,
      status: "error",
      error: message,
    };
  }
}

/**
 * Spawn an ACP sub-agent session
 *
 * This is the main entry point for spawning ACP sessions as sub-agents.
 * It creates a regular session first, then initializes it as an ACP session.
 */
export async function sessionsAcpSpawn(
  ctx: SessionAcpToolsContext,
  params: SessionsAcpSpawnParams,
  spawnSubAgentFn: (
    sessionManager: SessionManager,
    subAgentRegistry: SubAgentRegistry,
    options: {
      parentKey: string;
      agentId?: string;
      model?: string;
      task: string;
      label?: string;
      cleanup?: "delete" | "keep";
      timeoutSeconds?: number;
    },
  ) => Promise<SpawnResult>,
): Promise<SpawnResult> {
  // First, spawn a regular sub-agent
  const spawnResult = await spawnSubAgentFn(ctx.sessionManager, ctx.subAgentRegistry, {
    parentKey: ctx.currentSessionKey,
    agentId: params.agentId,
    model: params.model,
    task: params.task,
    label: params.label,
    cleanup: params.cleanup || "keep",
    timeoutSeconds: params.runTimeoutSeconds,
  });

  // If spawn was not accepted, return early
  if (spawnResult.status !== "accepted") {
    return spawnResult;
  }

  // If not using ACP, return the regular spawn result
  if (!shouldUseAcpSpawn(params)) {
    return spawnResult;
  }

  // Initialize the ACP sub-agent
  return initializeAcpSubAgent(ctx, params, spawnResult);
}
