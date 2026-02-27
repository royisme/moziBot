import { spawn } from "node:child_process";

const DEFAULT_GRACE_MS = 3000;
const MAX_GRACE_MS = 60_000;

/**
 * Best-effort process-tree termination with graceful shutdown.
 * - Windows: use taskkill /T to include descendants.
 * - Unix: send SIGTERM to process group first, wait grace period, then SIGKILL.
 */
export function killProcessTree(pid: number, opts?: { graceMs?: number }): void {
  if (!Number.isFinite(pid) || pid <= 0) {
    return;
  }

  const graceMs = normalizeGraceMs(opts?.graceMs);

  if (process.platform === "win32") {
    killProcessTreeWindows(pid, graceMs);
    return;
  }

  killProcessTreeUnix(pid, graceMs);
}

function normalizeGraceMs(value?: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_GRACE_MS;
  }
  return Math.max(0, Math.min(MAX_GRACE_MS, Math.floor(value)));
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function killProcessTreeUnix(pid: number, graceMs: number): void {
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      return;
    }
  }

  setTimeout(() => {
    if (isProcessAlive(-pid)) {
      try {
        process.kill(-pid, "SIGKILL");
        return;
      } catch {
        // fall through
      }
    }
    if (!isProcessAlive(pid)) {
      return;
    }
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
  }, graceMs).unref();
}

function runTaskkill(args: string[]): void {
  try {
    spawn("taskkill", args, { stdio: "ignore", detached: true });
  } catch {
    // ignore
  }
}

function killProcessTreeWindows(pid: number, graceMs: number): void {
  runTaskkill(["/T", "/PID", String(pid)]);
  setTimeout(() => {
    if (!isProcessAlive(pid)) return;
    runTaskkill(["/F", "/T", "/PID", String(pid)]);
  }, graceMs).unref();
}
