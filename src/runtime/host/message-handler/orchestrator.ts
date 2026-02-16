import type { MessageTurnHandler, MessageTurnContext, OrchestratorDeps } from "./contract";
import { MessageTurnRuntime } from "./turn-runtime";

/**
 * Message turn orchestrator
 *
 * Central coordinator that sequences the extracted message handling flows.
 * Manages flow control, error recovery, and resource cleanup.
 */
export class MessageTurnOrchestrator implements MessageTurnHandler {
  private readonly runtime: MessageTurnRuntime;

  constructor(deps: OrchestratorDeps) {
    this.runtime = new MessageTurnRuntime(deps);
  }

  async handle(ctx: MessageTurnContext): Promise<unknown> {
    return this.runtime.run(ctx);
  }
}
