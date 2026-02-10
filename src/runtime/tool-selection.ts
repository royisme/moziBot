export type NamedTool = { name: string };

export function resolveToolAllowList(params: {
  agentTools?: string[];
  defaultTools?: string[];
  fallbackTools: string[];
  requiredTools?: string[];
}): string[] {
  const required = params.requiredTools ?? [];
  const mergeRequired = (tools: string[]) => mergeToolNames(tools, required);

  if (Array.isArray(params.agentTools)) {
    return mergeRequired(params.agentTools);
  }
  if (Array.isArray(params.defaultTools)) {
    return mergeRequired(params.defaultTools);
  }
  return mergeRequired(params.fallbackTools);
}

export function filterTools<T extends NamedTool>(
  available: T[],
  allowed: string[],
): { tools: T[]; missing: string[] } {
  const allowedSet = new Set(allowed);
  const tools = available.filter((tool) => allowedSet.has(tool.name));
  const availableSet = new Set(available.map((tool) => tool.name));
  const missing = allowed.filter((name) => !availableSet.has(name));
  return { tools, missing };
}

function mergeToolNames(primary: string[], required: string[]): string[] {
  return Array.from(new Set([...primary, ...required]));
}
