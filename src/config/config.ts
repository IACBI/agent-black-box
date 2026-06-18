import { access, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AgentBlackBoxConfig, ConfigLoadResult } from "../types.js";
import { CONFIG_FILE_NAME, CONFIG_SCHEMA_URL, CURRENT_CONFIG_VERSION, DEFAULT_CONFIG } from "./defaults.js";

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
  const result = await loadConfigWithMeta(repoRoot);
  if (result.errors.length > 0) {
    throw new Error(formatConfigProblems("Invalid Agent Black Box config", result.errors));
  }

  return result.config;
}

export async function loadConfigWithMeta(repoRoot: string): Promise<ConfigLoadResult> {
  const configPath = getConfigPath(repoRoot);
  if (!(await configExists(repoRoot))) {
    return {
      config: cloneDefaultConfig(),
      configPath,
      exists: false,
      migrated: false,
      errors: [],
      warnings: []
    };
  }

  const raw = await readFile(configPath, "utf8");
  let parsed: unknown;

  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Failed to parse ${CONFIG_FILE_NAME}: ${(error as Error).message}`);
  }

  const result = normalizeConfig(parsed);
  return {
    ...result,
    configPath,
    exists: true
  };
}

export async function migrateConfigFile(repoRoot: string): Promise<ConfigLoadResult> {
  if (!(await configExists(repoRoot))) {
    throw new Error(`${CONFIG_FILE_NAME} does not exist. Run \`abb init\` first.`);
  }

  const result = await loadConfigWithMeta(repoRoot);
  if (result.errors.length > 0) {
    throw new Error(formatConfigProblems("Cannot migrate invalid Agent Black Box config", result.errors));
  }

  await writeFile(result.configPath, `${JSON.stringify(result.config, null, 2)}\n`, "utf8");
  return result;
}

export function formatConfigProblems(title: string, problems: string[]): string {
  return `${title}:\n${problems.map((problem) => `- ${problem}`).join("\n")}`;
}

function normalizeConfig(parsed: unknown): Omit<ConfigLoadResult, "configPath" | "exists"> {
  const warnings: string[] = [];
  const errors: string[] = [];

  if (!isRecord(parsed)) {
    return {
      config: cloneDefaultConfig(),
      migrated: false,
      errors: [`${CONFIG_FILE_NAME} must contain a JSON object.`],
      warnings
    };
  }

  const knownKeys = new Set(["$schema", "configVersion", "sessionDir", "exclude", "riskPatterns", "maxFileSizeKb"]);
  for (const key of Object.keys(parsed)) {
    if (!knownKeys.has(key)) {
      warnings.push(`Unknown config key "${key}" is ignored.`);
    }
  }

  const version = parsed.configVersion;
  let migrated = false;

  if (version === undefined) {
    migrated = true;
    warnings.push(`Legacy config without configVersion is migrated in memory to version ${CURRENT_CONFIG_VERSION}.`);
  } else if (version !== CURRENT_CONFIG_VERSION) {
    errors.push(`configVersion must be ${CURRENT_CONFIG_VERSION}. Found ${String(version)}.`);
  }

  const config: AgentBlackBoxConfig = {
    $schema: typeof parsed.$schema === "string" && parsed.$schema.length > 0 ? parsed.$schema : CONFIG_SCHEMA_URL,
    configVersion: CURRENT_CONFIG_VERSION,
    sessionDir: stringOrDefault(parsed.sessionDir, DEFAULT_CONFIG.sessionDir, "sessionDir", warnings),
    exclude: stringArrayOrDefault(parsed.exclude, DEFAULT_CONFIG.exclude, "exclude", warnings),
    riskPatterns: stringArrayOrDefault(parsed.riskPatterns, DEFAULT_CONFIG.riskPatterns, "riskPatterns", warnings),
    maxFileSizeKb: maxFileSizeOrDefault(parsed.maxFileSizeKb, warnings)
  };

  return {
    config,
    migrated,
    errors,
    warnings
  };
}

function cloneDefaultConfig(): AgentBlackBoxConfig {
  return {
    ...DEFAULT_CONFIG,
    exclude: [...DEFAULT_CONFIG.exclude],
    riskPatterns: [...DEFAULT_CONFIG.riskPatterns]
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringOrDefault(value: unknown, fallback: string, name: string, warnings: string[]): string {
  if (typeof value === "string" && value.trim().length > 0) {
    return value;
  }

  if (value !== undefined) {
    warnings.push(`${name} must be a non-empty string. Using default "${fallback}".`);
  }

  return fallback;
}

function stringArrayOrDefault(value: unknown, fallback: string[], name: string, warnings: string[]): string[] {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
    if (value !== undefined) {
      warnings.push(`${name} must be an array of strings. Using defaults.`);
    }
    return [...fallback];
  }

  const normalized = [...new Set(value.map((entry) => entry.trim()).filter(Boolean))];
  if (normalized.length !== value.length) {
    warnings.push(`${name} had empty or duplicate entries. They were removed in memory.`);
  }

  return normalized.length > 0 ? normalized : [...fallback];
}

function maxFileSizeOrDefault(value: unknown, warnings: string[]): number {
  if (Number.isInteger(value) && Number(value) >= 1 && Number(value) <= 102_400) {
    return Number(value);
  }

  if (value !== undefined) {
    warnings.push("maxFileSizeKb must be an integer between 1 and 102400. Using default.");
  }

  return DEFAULT_CONFIG.maxFileSizeKb;
}
