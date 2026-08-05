import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: false,
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
