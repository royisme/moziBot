import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import {
  browserToolSchema,
  runBrowserTool,
  type BrowserToolContext,
} from "../../../agents/tools/browser";

const BrowserToolParameters = Type.Object({
  action: Type.Union([
    Type.Literal("status"),
    Type.Literal("tabs"),
    Type.Literal("navigate"),
    Type.Literal("evaluate"),
    Type.Literal("screenshot"),
    Type.Literal("click"),
    Type.Literal("type"),
  ]),
  profile: Type.Optional(Type.String()),
  timeoutMs: Type.Optional(Type.Number()),
  targetId: Type.Optional(Type.String()),
  url: Type.Optional(Type.String()),
  expression: Type.Optional(Type.String()),
  selector: Type.Optional(Type.String()),
  text: Type.Optional(Type.String()),
  x: Type.Optional(Type.Number()),
  y: Type.Optional(Type.Number()),
  screenshot: Type.Optional(
    Type.Object({
      format: Type.Optional(Type.Union([Type.Literal("png"), Type.Literal("jpeg")])),
      quality: Type.Optional(Type.Number()),
    }),
  ),
});

export function createBrowserTools(ctx: BrowserToolContext): AgentTool[] {
  return [
    {
      name: "browser",
      label: "Browser",
      description:
        "Query browser status/tabs or run basic CDP actions (navigate/evaluate/click/type/screenshot) via local CDP or extension relay.",
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
