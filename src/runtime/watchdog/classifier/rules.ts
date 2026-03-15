import type { WatchdogState } from "../state-collector.js";

export function evaluateRules(state: WatchdogState): "wake" | "sleep" {
  if (state.pendingCronEvents.length > 0) {
    return "wake";
  }
  if (state.pendingReminders.length > 0) {
    return "wake";
  }
  if (state.isMemoryMaintenanceDue) {
    return "wake";
  }
  if (state.pendingSubagentResultCount > 0) {
    return "wake";
  }
  return "sleep";
}
