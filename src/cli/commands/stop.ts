import { Lifecycle, isProcessRunning } from "../../runtime/host/lifecycle";
import { resolveRuntimePaths } from "./runtime-paths";

export async function stopRuntime(options: { config?: string } = {}) {
  const runtime = resolveRuntimePaths(options.config);
  process.env.MOZI_PID_FILE = runtime.pidFile;
  if (!Lifecycle.checkExisting()) {
    console.error("Error: Mozi runtime is not running.");
    process.exit(1);
  }

  const pid = Lifecycle.getPid();
  if (pid === null) {
    console.error("Error: Mozi runtime PID file is missing.");
    process.exit(1);
  }

  console.log(`Stopping Mozi runtime (PID: ${pid})...`);

  try {
    process.kill(pid, "SIGTERM");
    console.log(`Sent SIGTERM to process ${pid}`);

    const timeoutMs = 10_000;
    const pollMs = 200;
    const startedAt = Date.now();

    while (Date.now() - startedAt < timeoutMs) {
      if (!isProcessRunning(pid)) {
        console.log("Runtime stopped.");
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }

    console.warn("Runtime is still running after 10s. You may need to stop it manually.");
    process.exit(1);
  } catch (error) {
    console.error(`Failed to stop runtime: ${(error as Error).message}`);
    process.exit(1);
  }
}
