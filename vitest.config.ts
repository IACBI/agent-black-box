import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: false,
    // Concurrent Git subprocesses and filesystem fixtures contend heavily on Windows.
    maxWorkers: process.platform === "win32" ? 1 : undefined,
    testTimeout: process.platform === "win32" ? 15_000 : undefined,
    include: ["tests/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/cli.ts", "src/index.ts", "src/types.ts"],
      reporter: ["text", "json-summary"],
      thresholds: {
        lines: 80,
        statements: 80,
        functions: 87,
        branches: 68,
      },
    },
  },
});
