import type {
  MessageTurnHandler,
  MessageTurnContext,
  OrchestratorDeps,
  CleanupBundle,
  PreparedPromptBundle,
} from "./contract";
import { runInboundFlow } from './flow/inbound-flow';
import { runCommandFlow } from './flow/command-flow';
import { runLifecycleFlow } from './flow/lifecycle-flow';
import { runPromptFlow } from './flow/prompt-flow';
import { runExecutionFlow } from './flow/execution-flow';
import { runErrorFlow } from './flow/error-flow';
import { runCleanupFlow } from './flow/cleanup-flow';

/**
 * Message turn orchestrator
 * 
 * Central coordinator that sequences the extracted message handling flows.
 * Manages flow control, error recovery, and resource cleanup.
 */
export class MessageTurnOrchestrator implements MessageTurnHandler {
  constructor(private readonly deps: OrchestratorDeps) {}

  /**
   * Orchestrates a single message turn through the canonical flow sequence.
   */
  async handle(ctx: MessageTurnContext): Promise<unknown> {
    let result: unknown = null;
    let preparedBundle: PreparedPromptBundle | undefined;

    try {
      // 1. Inbound Flow: Extraction, Parsing, Early Short-circuits
      const inboundRes = await runInboundFlow(ctx, this.deps);
      if (inboundRes === 'handled' || inboundRes === 'abort') {
        return null;
      }

      // 2. Command Flow: Routing to dedicated command handlers
      const commandRes = await runCommandFlow(ctx, this.deps);
      if (commandRes === 'handled' || commandRes === 'abort') {
        return null;
      }

      // 3. Lifecycle Flow: Temporal and Semantic session management
      const lifecycleRes = await runLifecycleFlow(ctx, this.deps);
      if (lifecycleRes === 'handled' || lifecycleRes === 'abort') {
        return null;
      }

      // 4. Prompt Flow: Media transcription, capability validation, and prep
      const promptRes = await runPromptFlow(ctx, this.deps);
      if (promptRes === 'handled' || promptRes === 'abort') {
        return null;
      }
      
      // If promptRes is not handled/abort/continue, it's the prepared bundle
      if (typeof promptRes === 'object' && promptRes !== null) {
        preparedBundle = promptRes;
      } else {
        // If it was 'continue' with no bundle, we have nothing to execute
        return null;
      }

      // 5. Execution Flow: Model interaction and reply delivery
      const executionRes = await runExecutionFlow(ctx, this.deps, preparedBundle);
      if (executionRes === 'handled' || executionRes === 'abort') {
        return null;
      }

      result = { success: true, messageId: ctx.messageId };

    } catch (error) {
      // 6. Centralized Error Path
      await runErrorFlow(ctx, this.deps, error);
    } finally {
      // 7. Guaranteed Cleanup Path
      const cleanupBundle: CleanupBundle = {
        correlationId: ctx.messageId,
        finalStatus: result ? 'success' : 'interrupted',
      };
      await runCleanupFlow(ctx, this.deps, cleanupBundle);
    }

    return result;
  }
}
