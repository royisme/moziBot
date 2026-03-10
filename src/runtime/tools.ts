import type { AgentTool } from "@mariozechner/pi-agent-core";
import {
  createEditTool,
  createFindTool,
  createGrepTool,
  createLsTool,
  createReadTool,
  createWriteTool,
} from "@mariozechner/pi-coding-agent";
import { Type, type Static } from "@sinclair/typebox";
import {
  memoryGet,
  memoryGetSchema,
  memorySearch,
  memorySearchSchema,
  type MemoryToolsContext,
} from "../agents/tools/memory";
import type { MemorySearchManager } from "../memory/types";
import { createProcessTool } from "../process";
import { SubagentRegistry } from "./subagent-registry";
import { createZodTool } from "./tool-utils";

const subagentSchema = Type.Object({
  prompt: Type.String({ minLength: 1 }),
  agentId: Type.Optional(Type.String()),
  model: Type.Optional(Type.String()),
  timeoutSeconds: Type.Optional(Type.Number({ minimum: 1 })),
});

export function createSubagentTool(params: {
  subagents: SubagentRegistry;
  parentSessionKey: string;
  parentAgentId: string;
}): AgentTool {
  return {
    name: "subagent_run",
    label: "Subagent Run",
    description: "Run a subagent with a prompt",
    parameters: subagentSchema,
    execute: async (_toolCallId, args: unknown) => {
      const { prompt, agentId, model, timeoutSeconds } = args as Static<typeof subagentSchema>;
      const result = await params.subagents.spawn({
        parentSessionKey: params.parentSessionKey,
        parentAgentId: params.parentAgentId,
        prompt,
        agentId,
        model,
        timeoutSeconds,
      });
      const text =
        result.status === "accepted"
          ? `Subagent accepted. Run ID: ${result.runId}`
          : result.error || "Subagent request failed.";
      return {
        content: [{ type: "text", text }],
        details: {
          runId: result.runId,
          childKey: result.childKey,
          sessionId: result.sessionId,
          status: result.status,
          ...(result.error ? { error: result.error } : {}),
        },
      };
    },
  };
}

export function createMemoryTools(params: {
  manager: MemorySearchManager;
  sessionKey: string;
}): AgentTool[] {
  const ctx: MemoryToolsContext = {
    manager: params.manager,
    sessionKey: params.sessionKey,
  };

  return [
    createZodTool({
      name: "memory_search",
      label: "Memory Search",
      description: "Search memory files for relevant context",
      parameters: Type.Object({
        query: Type.String({ minLength: 1 }),
        maxResults: Type.Optional(Type.Number()),
        minScore: Type.Optional(Type.Number()),
      }),
      schema: memorySearchSchema,
      ctx,
      execute: memorySearch,
    }),
    createZodTool({
      name: "memory_get",
      label: "Memory Get",
      description: "Read a memory file snippet",
      parameters: Type.Object({
        path: Type.String({ minLength: 1 }),
        from: Type.Optional(Type.Number()),
        lines: Type.Optional(Type.Number()),
      }),
      schema: memoryGetSchema,
      ctx,
      execute: memoryGet,
    }),
  ];
}

export function createPiCodingTools(workspaceDir: string): AgentTool[] {
  return [
    createReadTool(workspaceDir),
    createEditTool(workspaceDir),
    createWriteTool(workspaceDir),
    createGrepTool(workspaceDir),
    createFindTool(workspaceDir),
    createLsTool(workspaceDir),
  ] as unknown as AgentTool[];
}

export function createProcessTools(params: { sessionKey: string; agentId: string }): AgentTool[] {
  return [createProcessTool(params)];
}
