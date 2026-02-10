import { loadConfig } from "../../config";
import {
  bootstrapSandboxes,
  formatBootstrapSummary,
  type SandboxBootstrapResult,
} from "../../runtime/sandbox/bootstrap";

function printBootstrapResult(result: SandboxBootstrapResult) {
  const lines = formatBootstrapSummary(result);
  for (const line of lines) {
    console.log(line);
  }
}

export async function runSandboxBootstrap(options: {
  config?: string;
  check?: boolean;
  autoOnly?: boolean;
}) {
  const loaded = loadConfig(options.config);
  if (!loaded.success || !loaded.config) {
    console.error("❌ Configuration is invalid:");
    for (const error of loaded.errors ?? []) {
      console.error(`- ${error}`);
    }
    process.exit(1);
  }

  const result = await bootstrapSandboxes(loaded.config, {
    fix: !options.check,
    onlyAutoEnabled: options.autoOnly,
  });
  printBootstrapResult(result);

  if (!result.ok) {
    process.exit(1);
  }
}
