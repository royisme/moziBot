import type { z } from "zod";
import type { SessionToolsContext } from "./sessions";
import {
  type MemoryToolsContext,
  memoryGet,
  memoryGetSchema,
  memorySearch,
  memorySearchSchema,
} from "./memory";
import {
  sessionsHistory,
  sessionsHistorySchema,
  sessionsList,
  sessionsListSchema,
  sessionsSend,
  sessionsSendSchema,
  sessionsSpawn,
  sessionsSpawnSchema,
} from "./sessions";

export { sessionsStatus, sessionsStatusSchema, sessionsStatusDescription } from "./sessions-status";

export interface AgentTool {
  name: string;
  description: string;
  parameters: z.ZodSchema;
  execute: (ctx: unknown, params: unknown) => Promise<unknown>;
}

export const sessionTools: AgentTool[] = [
  {
    name: "sessions_list",
    description: "List active sessions with optional filters",
    parameters: sessionsListSchema,
    execute: sessionsList,
  },
  {
    name: "sessions_history",
    description: "Get message history for a session",
    parameters: sessionsHistorySchema,
    execute: sessionsHistory,
  },
  {
    name: "sessions_send",
    description: "Send a message to another session",
    parameters: sessionsSendSchema,
    execute: sessionsSend,
  },
  {
    name: "sessions_spawn",
    description: "Spawn a sub-agent to handle a sub-task",
    parameters: sessionsSpawnSchema,
    execute: sessionsSpawn,
  },
];

export const memoryTools: AgentTool[] = [
  {
    name: "memory_search",
    description: `Semantic search MEMORY.md and memory/*.md files.
Must be called before answering questions about previous work, decisions, dates, people, preferences, or todos.`,
    parameters: memorySearchSchema,
    execute: memorySearch,
  },
  {
    name: "memory_get",
    description: `Read specified line range from MEMORY.md or memory/*.md.
Usually called after memory_search.`,
    parameters: memoryGetSchema,
    execute: memoryGet,
  },
];

export type { SessionToolsContext, MemoryToolsContext };
