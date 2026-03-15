export type WatchdogState = {
  agentId: string;
  sessionKey: string;
  pendingCronEvents: unknown[];
  pendingReminders: unknown[];
  isMemoryMaintenanceDue: boolean;
  pendingSubagentResultCount: number;
  customWatchdogContext?: string;
};

export interface WatchdogStateInputs {
  getCronEvents: (agentId: string) => unknown[];
  getReminders: (sessionKey: string) => unknown[];
  isMemoryMaintenanceDue: (agentId: string) => boolean;
  getPendingSubagentResultCount: (sessionKey: string) => number;
}

export class WatchdogStateCollector {
  constructor(private readonly inputs: WatchdogStateInputs) {}

  collect(agentId: string, sessionKey: string, customContext?: string): WatchdogState {
    return {
      agentId,
      sessionKey,
      pendingCronEvents: this.inputs.getCronEvents(agentId),
      pendingReminders: this.inputs.getReminders(sessionKey),
      isMemoryMaintenanceDue: this.inputs.isMemoryMaintenanceDue(agentId),
      pendingSubagentResultCount: this.inputs.getPendingSubagentResultCount(sessionKey),
      customWatchdogContext: customContext,
    };
  }
}
