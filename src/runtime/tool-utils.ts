import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { TSchema } from "@sinclair/typebox";
import type { z } from "zod";
import { inspect } from "node:util";

function formatToolResult(result: unknown): string {
  if (typeof result === "string") {
    return result;
  }
  if (result === undefined) {
    return "";
  }
  try {
    return JSON.stringify(result);
  } catch {
    return inspect(result);
  }
}

export function createZodTool<TContext, TParams>(params: {
  name: string;
  label: string;
  description: string;
  parameters: TSchema;
  schema: z.ZodType<TParams>;
  ctx: TContext;
  execute: (ctx: TContext, params: TParams) => Promise<unknown>;
}): AgentTool {
  return {
    name: params.name,
    label: params.label,
    description: params.description,
    parameters: params.parameters,
    execute: async (_toolCallId, args) => {
      const parsed = params.schema.safeParse(args);
      if (!parsed.success) {
        return {
          content: [
            {
              type: "text",
              text: `Invalid tool arguments: ${parsed.error.message}`,
            },
          ],
          details: {},
        };
      }
      const result = await params.execute(params.ctx, parsed.data);
      return {
        content: [{ type: "text", text: formatToolResult(result) }],
        details: {},
      };
    },
  };
}
