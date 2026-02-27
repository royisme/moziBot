import type { ChildProcessWithoutNullStreams, SpawnOptions } from "node:child_process";
import { spawn } from "node:child_process";
import { killProcessTree } from "../../kill-tree.js";
import type { ManagedRunStdin, SpawnProcessAdapter } from "../types.js";
import { toStringEnv } from "./env.js";

export type ChildAdapter = SpawnProcessAdapter<NodeJS.Signals | null>;

export async function createChildAdapter(params: {
  argv: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  windowsVerbatimArguments?: boolean;
  input?: string;
  stdinMode?: "inherit" | "pipe-open" | "pipe-closed";
}): Promise<ChildAdapter> {
  const [cmd, ...args] = params.argv;
  if (!cmd) {
    throw new Error("spawn argv cannot be empty");
  }

  const stdinMode = params.stdinMode ?? (params.input !== undefined ? "pipe-closed" : "inherit");

  // On POSIX, detached=true creates a new process group so child survives parent exit
  // and killProcessTree can SIGTERM the whole group. On Windows, skip detached.
  const useDetached = process.platform !== "win32";

  const options: SpawnOptions = {
    cwd: params.cwd,
    env: params.env ? toStringEnv(params.env) : undefined,
    stdio: stdinMode === "inherit" ? ["inherit", "pipe", "pipe"] : ["pipe", "pipe", "pipe"],
    detached: useDetached,
    windowsHide: true,
    windowsVerbatimArguments: params.windowsVerbatimArguments,
  };

  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawn(cmd, args, options) as ChildProcessWithoutNullStreams;
  } catch (err) {
    if (useDetached) {
      // Retry without detached (e.g. EBADF in some environments)
      child = spawn(cmd, args, {
        ...options,
        detached: false,
      }) as ChildProcessWithoutNullStreams;
    } else {
      throw err;
    }
  }

  if (child.stdin) {
    if (params.input !== undefined) {
      child.stdin.write(params.input);
      child.stdin.end();
    } else if (stdinMode === "pipe-closed") {
      child.stdin.end();
    }
  }

  const stdin: ManagedRunStdin | undefined = child.stdin
    ? {
        destroyed: false,
        write: (data, cb) => {
          try {
            child.stdin.write(data, cb);
          } catch (err) {
            cb?.(err as Error);
          }
        },
        end: () => {
          try { child.stdin.end(); } catch { /* ignore */ }
        },
        destroy: () => {
          try { child.stdin.destroy(); } catch { /* ignore */ }
        },
      }
    : undefined;

  const onStdout = (listener: (chunk: string) => void) => {
    child.stdout.on("data", (chunk) => listener(chunk.toString()));
  };

  const onStderr = (listener: (chunk: string) => void) => {
    child.stderr.on("data", (chunk) => listener(chunk.toString()));
  };

  const wait = async () =>
    new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
    });

  const kill = (signal?: NodeJS.Signals) => {
    const pid = child.pid ?? undefined;
    if (signal === undefined || signal === "SIGKILL") {
      if (pid) {
        killProcessTree(pid);
      } else {
        try { child.kill("SIGKILL"); } catch { /* ignore */ }
      }
      return;
    }
    try { child.kill(signal); } catch { /* ignore */ }
  };

  const dispose = () => {
    child.removeAllListeners();
  };

  return {
    pid: child.pid ?? undefined,
    stdin,
    onStdout,
    onStderr,
    wait,
    kill,
    dispose,
  };
}
