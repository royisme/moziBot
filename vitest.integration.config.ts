import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    testTimeout: 120_000,
    hookTimeout: 120_000,
    include: ["src/**/*.integration.test.ts"],
    exclude: ["dist/**", "**/node_modules/**", "**/vendor/**"],
  },
});
