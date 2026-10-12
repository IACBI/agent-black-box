import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: false,
    globalSetup: ["tests/globalSetup.ts"],
    setupFiles: ["tests/setup.ts"],
    // Concurrent Git subprocesses and filesystem fixtures contend on Windows, so parallelism stays low.
    maxWorkers: process.platform === "win32" ? 2 : undefined,
    testTimeout: process.platform === "win32" ? 15_000 : undefined,
    include: ["tests/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/cli.ts", "src/index.ts", "src/types.ts"],
      reporter: ["text", "json-summary", "lcov"],
      thresholds: {
        lines: 88,
        statements: 88,
        functions: 94,
        branches: 82,
      },
    },
  },
});
