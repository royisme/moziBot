import { config as loadDotEnv } from "dotenv";
import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

loadDotEnv({ path: resolve(process.cwd(), ".env.local"), override: false });

export default defineConfig({
  test: {
    testTimeout: 120_000,
    hookTimeout: 120_000,
    include: ["src/**/*.test.ts"],
    exclude: [
      "dist/**",
      "**/node_modules/**",
      "**/vendor/**",
      "**/*.live.test.ts",
      "**/*.e2e.test.ts",
      "**/*.integration.test.ts",
    ],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      thresholds: {
        lines: 70,
        functions: 70,
        branches: 55,
        statements: 70,
      },
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts"],
    },
  },
});
