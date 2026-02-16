import type {
  CleanupBundle,
  MessageTurnContext,
  OrchestratorDeps,
  PreparedPromptBundle,
} from "./contract";
import { runCleanupFlow } from "./flow/cleanup-flow";
import { runCommandFlow } from "./flow/command-flow";
import { runErrorFlow } from "./flow/error-flow";
import { runExecutionFlow } from "./flow/execution-flow";
import { runInboundFlow } from "./flow/inbound-flow";
import { runLifecycleFlow } from "./flow/lifecycle-flow";
import { runPromptFlow } from "./flow/prompt-flow";

type StageOutcome =
  | { kind: "continue" }
  | { kind: "handled" }
  | { kind: "abort" }
  | { kind: "bundle"; bundle: PreparedPromptBundle };

type StageContext = {
  promptBundle?: PreparedPromptBundle;
};

type RuntimeStage = {
  name: string;
  run: (
    ctx: MessageTurnContext,
    deps: OrchestratorDeps,
    stageContext: StageContext,
  ) => Promise<StageOutcome>;
};

function toStageOutcome(result: "continue" | "handled" | "abort"): StageOutcome {
  if (result === "handled") {
    return { kind: "handled" };
  }
  if (result === "abort") {
    return { kind: "abort" };
  }
  return { kind: "continue" };
}

const TURN_STAGES: RuntimeStage[] = [
  {
    name: "inbound",
    run: async (ctx, deps) => toStageOutcome(await runInboundFlow(ctx, deps)),
  },
  {
    name: "command",
    run: async (ctx, deps) => toStageOutcome(await runCommandFlow(ctx, deps)),
  },
  {
    name: "lifecycle",
    run: async (ctx, deps) => toStageOutcome(await runLifecycleFlow(ctx, deps)),
  },
  {
    name: "prompt",
    run: async (ctx, deps) => {
      const promptRes = await runPromptFlow(ctx, deps);
      if (promptRes === "handled") {
        return { kind: "handled" };
      }
      if (promptRes === "abort") {
        return { kind: "abort" };
      }
      if (promptRes === "continue") {
        return { kind: "continue" };
      }
      return { kind: "bundle", bundle: promptRes };
    },
  },
  {
    name: "execution",
    run: async (ctx, deps, stageContext) => {
      if (!stageContext.promptBundle) {
        return { kind: "handled" };
      }
      return toStageOutcome(await runExecutionFlow(ctx, deps, stageContext.promptBundle));
    },
  },
];

export class MessageTurnRuntime {
  constructor(private readonly deps: OrchestratorDeps) {}

  async run(ctx: MessageTurnContext): Promise<unknown> {
    let result: unknown = null;
    const stageContext: StageContext = {};

    try {
      for (const stage of TURN_STAGES) {
        const stageOutcome = await stage.run(ctx, this.deps, stageContext);

        if (stageOutcome.kind === "bundle") {
          stageContext.promptBundle = stageOutcome.bundle;
          continue;
        }

        if (stageOutcome.kind === "handled" || stageOutcome.kind === "abort") {
          return null;
        }
      }

      result = { success: true, messageId: ctx.messageId };
    } catch (error) {
      await runErrorFlow(ctx, this.deps, error);
    } finally {
      const cleanupBundle: CleanupBundle = {
        correlationId: ctx.messageId,
        finalStatus: result ? "success" : "interrupted",
      };
      await runCleanupFlow(ctx, this.deps, cleanupBundle);
    }

    return result;
  }
}
