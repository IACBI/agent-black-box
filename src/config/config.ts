import { access, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AgentBlackBoxConfig } from "../types.js";
import { CONFIG_FILE_NAME, DEFAULT_CONFIG } from "./defaults.js";

export function getConfigPath(repoRoot: string): string {
  return path.join(repoRoot, CONFIG_FILE_NAME);
}

export async function configExists(repoRoot: string): Promise<boolean> {
  try {
    await access(getConfigPath(repoRoot));
    return true;
  } catch {
    return false;
  }
}

export async function createDefaultConfig(repoRoot: string): Promise<string> {
  const configPath = getConfigPath(repoRoot);
  if (await configExists(repoRoot)) {
    throw new Error(`${CONFIG_FILE_NAME} already exists.`);
  }

  await writeFile(configPath, `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`, "utf8");
  return configPath;
}

export async function loadConfig(repoRoot: string): Promise<AgentBlackBoxConfig> {
  if (!(await configExists(repoRoot))) {
    return { ...DEFAULT_CONFIG };
  }

  const raw = await readFile(getConfigPath(repoRoot), "utf8");
  let parsed: Partial<AgentBlackBoxConfig>;

  try {
    parsed = JSON.parse(raw) as Partial<AgentBlackBoxConfig>;
  } catch (error) {
    throw new Error(`Failed to parse ${CONFIG_FILE_NAME}: ${(error as Error).message}`);
  }

  return normalizeConfig(parsed);
}

function normalizeConfig(parsed: Partial<AgentBlackBoxConfig>): AgentBlackBoxConfig {
  return {
    sessionDir: typeof parsed.sessionDir === "string" ? parsed.sessionDir : DEFAULT_CONFIG.sessionDir,
    exclude: stringArrayOrDefault(parsed.exclude, DEFAULT_CONFIG.exclude),
    riskPatterns: stringArrayOrDefault(parsed.riskPatterns, DEFAULT_CONFIG.riskPatterns),
    maxFileSizeKb:
      typeof parsed.maxFileSizeKb === "number" && parsed.maxFileSizeKb > 0
        ? parsed.maxFileSizeKb
        : DEFAULT_CONFIG.maxFileSizeKb
  };
}

function stringArrayOrDefault(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
    return [...fallback];
  }

  return [...value];
}
