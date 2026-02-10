import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import type { SandboxExecutor } from "./executor";

type AuthResolver = {
  getValue: (params: {
    name: string;
    agentId: string;
    scope?: { type: "global" } | { type: "agent"; agentId: string };
  }) => Promise<string | null>;
};

const PROTECTED_AUTH_NAME_RE = /^[A-Z][A-Z0-9_]*_API_KEY$/;

function isProtectedAuthName(name: string): boolean {
  return PROTECTED_AUTH_NAME_RE.test(name);
}

function blockProtectedSecretsInEnv(env?: Record<string, string>): string[] {
  if (!env) {
    return [];
  }
  return Object.keys(env).filter((key) => isProtectedAuthName(key));
}

function sanitizeAuthRefName(name: string): string {
  return name.trim().toUpperCase();
}

type ExecToolArgs = {
  command: string;
  cwd?: string;
  env?: Record<string, string>;
  authRefs?: string[];
};

function normalizeExecArgs(raw: unknown): ExecToolArgs {
  const args = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const env =
    args.env && typeof args.env === "object"
      ? Object.fromEntries(
          Object.entries(args.env as Record<string, unknown>).filter(
            (entry): entry is [string, string] => typeof entry[1] === "string",
          ),
        )
      : undefined;
  const authRefs = Array.isArray(args.authRefs)
    ? args.authRefs.filter((value): value is string => typeof value === "string")
    : undefined;

  return {
    command: typeof args.command === "string" ? args.command : "",
    cwd: typeof args.cwd === "string" ? args.cwd : undefined,
    env,
    authRefs,
  };
}

export function createExecTool(params: {
  executor: SandboxExecutor;
  sessionKey: string;
  agentId: string;
  workspaceDir: string;
  allowedSecrets?: string[];
  authResolver?: AuthResolver;
}): AgentTool {
  const authResolver = params.authResolver;
  const allowedSecrets = new Set(
    (params.allowedSecrets ?? []).map((name) => sanitizeAuthRefName(name)),
  );

  return {
    name: "exec",
    label: "Exec",
    description: "Run a shell command (sandbox mode: docker/apple-vm/off)",
    parameters: Type.Object({
      command: Type.String({ minLength: 1 }),
      cwd: Type.Optional(Type.String()),
      env: Type.Optional(Type.Record(Type.String(), Type.String())),
      authRefs: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
    }),
    execute: async (_toolCallId, args) => {
      const input = normalizeExecArgs(args);
      const protectedKeys = blockProtectedSecretsInEnv(input.env);
      if (protectedKeys.length > 0) {
        return {
          content: [
            {
              type: "text",
              text: `Protected auth env vars are not allowed in env: ${protectedKeys.join(", ")}. Use authRefs instead.`,
            },
          ],
          details: {},
        };
      }

      const authRefs = Array.isArray(input.authRefs)
        ? input.authRefs
            .map((value) => (typeof value === "string" ? sanitizeAuthRefName(value) : ""))
            .filter((value) => value.length > 0)
        : [];

      if (authRefs.length > 0 && !authResolver) {
        return {
          content: [
            {
              type: "text",
              text: "Auth broker is disabled for this runtime. Enable runtime.auth.enabled to use authRefs.",
            },
          ],
          details: {},
        };
      }

      const denied = authRefs.filter((name) => !allowedSecrets.has(name));
      if (denied.length > 0) {
        return {
          content: [
            {
              type: "text",
              text: `Secret(s) not allowed for this agent: ${denied.join(", ")}`,
            },
          ],
          details: {},
        };
      }

      const resolvedAuth: Record<string, string> = {};
      for (const ref of authRefs) {
        const value = await authResolver!.getValue({
          name: ref,
          agentId: params.agentId,
        });
        if (!value) {
          throw new Error(`AUTH_MISSING ${ref}`);
        }
        resolvedAuth[ref] = value;
      }

      const result = await params.executor.exec({
        sessionKey: params.sessionKey,
        agentId: params.agentId,
        workspaceDir: params.workspaceDir,
        command: input.command,
        cwd: input.cwd,
        env: { ...input.env, ...resolvedAuth },
      });
      return {
        content: [
          {
            type: "text",
            text: [
              `exitCode: ${result.exitCode}`,
              result.stdout ? `stdout:\n${result.stdout}` : "stdout:",
              result.stderr ? `stderr:\n${result.stderr}` : "stderr:",
            ].join("\n"),
          },
        ],
        details: {},
      };
    },
  };
}
