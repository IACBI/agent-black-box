import type { AgentBlackBoxConfig } from "../types.js";

export const CONFIG_FILE_NAME = ".agentblackbox.json";

export const DEFAULT_CONFIG: AgentBlackBoxConfig = {
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
