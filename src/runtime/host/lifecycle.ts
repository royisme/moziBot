import fs from "node:fs";
import path from "node:path";
import process from "node:process";

function resolvePidFile(): string {
  const envPath = process.env.MOZI_PID_FILE;
  if (envPath && envPath.trim().length > 0) {
    return path.resolve(envPath);
  }
  return path.resolve(process.cwd(), "data/mozi.pid");
}

/**
 * Ensures the data directory exists.
 */
function ensureDataDir() {
  const dataDir = path.dirname(resolvePidFile());
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
}

/**
 * Checks if a process with the given PID is actually running.
 */
export function isProcessRunning(pid: number): boolean {
  try {
    // Signal 0 checks if the process exists without actually sending a signal
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Manages the PID file for the Runtime host.
 */
export const Lifecycle = {
  writePid(): void {
    ensureDataDir();
    if (this.checkExisting()) {
      throw new Error("Runtime is already running (PID file exists and process is active).");
    }
    fs.writeFileSync(resolvePidFile(), process.pid.toString(), "utf8");
  },

  removePid(): void {
    const pidFile = resolvePidFile();
    if (fs.existsSync(pidFile)) {
      const content = fs.readFileSync(pidFile, "utf8").trim();
      const pid = Number.parseInt(content, 10);
      if (pid === process.pid) {
        fs.unlinkSync(pidFile);
      }
    }
  },

  checkExisting(): boolean {
    const pidFile = resolvePidFile();
    if (fs.existsSync(pidFile)) {
      const content = fs.readFileSync(pidFile, "utf8").trim();
      const pid = Number.parseInt(content, 10);
      if (!Number.isNaN(pid) && isProcessRunning(pid)) {
        return true;
      }
      // If not running, we should probably clean up the stale PID file
      console.warn(`Stale PID file found (PID: ${pid}). Cleaning up.`);
      fs.unlinkSync(pidFile);
    }
    return false;
  },

  getPid(): number | null {
    const pidFile = resolvePidFile();
    if (fs.existsSync(pidFile)) {
      const content = fs.readFileSync(pidFile, "utf8").trim();
      const pid = Number.parseInt(content, 10);
      return Number.isNaN(pid) ? null : pid;
    }
    return null;
  },

  isDaemon(): boolean {
    return process.env.MOZI_DAEMON === "true" || process.argv.includes("--daemon");
  },
};
