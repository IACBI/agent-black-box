import type { KnipConfig } from "knip";

const config: KnipConfig = {
  entry: ["src/index.ts"],
  project: ["src/**/*.ts", "tests/**/*.ts", "scripts/**/*.ts"],
};

export default config;
