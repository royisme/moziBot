export type BrowserTarget = {
  id?: string;
  targetId?: string;
  type?: string;
  title?: string;
  url?: string;
  webSocketDebuggerUrl?: string;
};

export type ResolveTargetIdResult =
  | { ok: true; targetId: string }
  | { ok: false; reason: "not_found" | "ambiguous" };

export function normalizeTargetId(target: BrowserTarget): string | undefined {
  return target.id ?? target.targetId;
}

export function resolveTargetIdFromTargets(
  rawTargetId: string,
  targets: BrowserTarget[],
): ResolveTargetIdResult {
  const raw = rawTargetId.trim();
  if (!raw) {
    return { ok: false, reason: "not_found" };
  }
  const exact = targets.find((target) => normalizeTargetId(target) === raw);
  if (exact) {
    const id = normalizeTargetId(exact);
    if (id) {
      return { ok: true, targetId: id };
    }
  }
  const matches = targets.filter((target) => normalizeTargetId(target)?.startsWith(raw));
  if (matches.length === 1) {
    const id = normalizeTargetId(matches[0]);
    if (id) {
      return { ok: true, targetId: id };
    }
  }
  if (matches.length > 1) {
    return { ok: false, reason: "ambiguous" };
  }
  return { ok: false, reason: "not_found" };
}

export function pickDefaultTarget(
  targets: BrowserTarget[],
  lastTargetId?: string,
): BrowserTarget | null {
  if (targets.length === 0) {
    return null;
  }
  if (lastTargetId) {
    const resolved = resolveTargetIdFromTargets(lastTargetId, targets);
    if (resolved.ok) {
      const match = targets.find((target) => normalizeTargetId(target) === resolved.targetId);
      if (match) {
        return match;
      }
    }
  }
  const page = targets.find((target) => (target.type ?? "page") === "page");
  return page ?? targets[0] ?? null;
}
