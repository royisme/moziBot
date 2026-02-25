import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import {
  browserToolSchema,
  runBrowserTool,
  type BrowserToolContext,
} from "../../../agents/tools/browser";

const BrowserToolParameters = Type.Object({
  action: Type.Union([Type.Literal("status"), Type.Literal("tabs")]),
  profile: Type.Optional(Type.String()),
  timeoutMs: Type.Optional(Type.Number()),
});

export function createBrowserTools(ctx: BrowserToolContext): AgentTool[] {
  return [
    {
      name: "browser",
      label: "Browser",
      description:
        "Query browser status or list tabs via local CDP or Chrome extension relay (profile-based).",
      parameters: BrowserToolParameters,
      execute: async (_toolCallId, args) => {
        const parsed = browserToolSchema.safeParse(args);
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
        return await runBrowserTool(ctx, parsed.data);
      },
    },
  ];
}
