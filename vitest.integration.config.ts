import { resolve } from "node:path";
import { config as loadDotEnv } from "dotenv";
import { defineConfig } from "vitest/config";

loadDotEnv({ path: resolve(process.cwd(), ".env.local"), override: false });

export default defineConfig({
  test: {
    globalSetup: ["./vitest.global-setup.ts"],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    include: ["src/**/*.integration.test.ts"],
    exclude: ["dist/**", "**/node_modules/**", "**/vendor/**"],
  },
});
