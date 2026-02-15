import { config as loadDotEnv } from "dotenv";
import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

loadDotEnv({ path: resolve(process.cwd(), ".env.local"), override: false });

export default defineConfig({
  test: {
    testTimeout: 120_000,
    hookTimeout: 120_000,
    include: ["src/**/*.integration.test.ts"],
    exclude: ["dist/**", "**/node_modules/**", "**/vendor/**"],
  },
});
