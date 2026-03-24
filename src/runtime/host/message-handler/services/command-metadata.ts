export const COMMAND_METADATA: Record<string, { bypassQueue: boolean }> = {
  tasks: { bypassQueue: true },
  status: { bypassQueue: true },
  models: { bypassQueue: true },
  skills: { bypassQueue: true },
  skill: { bypassQueue: true },
  whoami: { bypassQueue: true },
  help: { bypassQueue: true },
  reminders: { bypassQueue: true },
  prompt_digest: { bypassQueue: true },
  heartbeat: { bypassQueue: true },
  context: { bypassQueue: true },
};

export function isBypassCommand(name: string): boolean {
  return COMMAND_METADATA[name]?.bypassQueue ?? false;
}
