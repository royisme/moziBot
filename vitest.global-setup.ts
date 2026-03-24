import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const TEMP_DIR_PATTERNS = [
  /^mozi-acp-doctor-/,
  /^mozi-ext-/,
  /^mozi-embedded-/,
  /^mozi-incomplete-/,
  /^mozi-sandbox-test-/,
  /^tape-test-/,
  /^tape-store-test-/,
  /^tape-service-test-/,
  /^tape-compaction-test-/,
  /^tape-dual-write-test-/,
  /^tape-fork-merge-test-/,
  /^tape-integration-test-/,
  /^node-compile-cache$/,
  /^tsx-/,
];

function cleanTempDirs() {
  const root = process.cwd();
  let cleaned = 0;

  try {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (entry.isDirectory() && TEMP_DIR_PATTERNS.some((pattern) => pattern.test(entry.name))) {
        rmSync(join(root, entry.name), { recursive: true, force: true });
        cleaned++;
      }
    }

    if (cleaned > 0) {
      console.log(`[vitest global-setup] Cleaned ${cleaned} temp test directories`);
    }
  } catch {
    // Best-effort cleanup
  }
}

// vitest globalSetup: return teardown function from setup()
export function setup() {
  return cleanTempDirs;
}
