import type { AgentBlackBoxConfig } from "../types.js";

export const CONFIG_FILE_NAME = ".agentblackbox.json";
export const CURRENT_CONFIG_VERSION = 1;
export const CONFIG_SCHEMA_URL =
  "https://raw.githubusercontent.com/IACBI/agent-black-box/main/schema/agentblackbox.schema.json";

export const DEFAULT_CONFIG: AgentBlackBoxConfig = {
  $schema: CONFIG_SCHEMA_URL,
  configVersion: CURRENT_CONFIG_VERSION,
  sessionDir: ".agent-black-box/sessions",
  exclude: [
    "node_modules",
    ".git",
    "dist",
    "build",
    "coverage",
    ".next",
    ".agent-black-box"
  ],
  riskPatterns: [
    ".env",
    ".github/workflows",
    "Dockerfile",
    "docker-compose",
    "package.json",
    "pnpm-lock.yaml",
    "package-lock.json",
    "yarn.lock",
    "requirements.txt",
    "pyproject.toml",
    "Cargo.toml",
    "go.mod",
    "migrations",
    "auth",
    "security",
    "config"
  ],
  maxFileSizeKb: 500
};
