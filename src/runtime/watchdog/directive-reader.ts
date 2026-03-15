export type HeartbeatDirectives = {
  enabled: boolean;
  intervalMs: number | null;
  prompt: string | null;
};

export function parseEveryMs(raw: string): number | null {
  const value = raw.trim().toLowerCase();
  if (!value) {
    return null;
  }
  const match = /^([0-9]+)\s*(ms|s|m|h|d)$/.exec(value);
  if (!match) {
    return null;
  }
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) {
    return null;
  }
  const unit = match[2];
  const multipliers: Record<string, number> = {
    ms: 1,
    s: 1000,
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
  };
  return amount * (multipliers[unit] || 0);
}

export function parseHeartbeatDirectives(content: string): HeartbeatDirectives {
  let enabled = true;
  let intervalMs: number | null = null;
  let prompt: string | null = null;

  const lines = content.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    const enableMatch = trimmed.match(/^@heartbeat\s+enabled\s*=\s*(on|off|true|false)$/i);
    if (enableMatch) {
      const value = enableMatch[1]?.toLowerCase();
      enabled = value === "on" || value === "true";
      continue;
    }

    const everyMatch = trimmed.match(/^@heartbeat\s+every\s*=\s*([^\s#]+)$/i);
    if (everyMatch) {
      const parsed = parseEveryMs((everyMatch[1] || "").trim());
      if (parsed && parsed > 0) {
        intervalMs = parsed;
      }
      continue;
    }

    const promptMatch = trimmed.match(/^@heartbeat\s+prompt\s*=\s*(.+)$/i);
    if (promptMatch) {
      const p = (promptMatch[1] || "").trim();
      if (p) {
        prompt = p;
      }
      continue;
    }
  }

  return { enabled, intervalMs, prompt };
}
