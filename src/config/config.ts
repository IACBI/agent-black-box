import { access, realpath } from "node:fs/promises";
import path from "node:path";
import type { AgentBlackBoxConfig, ConfigLoadResult } from "../types.js";
import { CONFIG_FILE_NAME, CONFIG_SCHEMA_URL, CURRENT_CONFIG_VERSION, DEFAULT_CONFIG } from "./defaults.js";
import { pathExists, readTextFileLimited, writeTextFileAtomic } from "../utils/files.js";

const MAX_CONFIG_BYTES = 1024 * 1024;

export interface ConfigLoadOptions {
  allowExternalSessionDir?: boolean;
}

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

  await writeTextFileAtomic(configPath, `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`);
  return configPath;
}

export async function loadConfig(repoRoot: string, options?: ConfigLoadOptions): Promise<AgentBlackBoxConfig> {
  const result = await loadConfigWithMeta(repoRoot, options);
  if (result.errors.length > 0) {
    throw new Error(formatConfigProblems("Invalid Agent Black Box config", result.errors));
  }

  return result.config;
}

export async function loadConfigWithMeta(repoRoot: string, options?: ConfigLoadOptions): Promise<ConfigLoadResult> {
  const configPath = getConfigPath(repoRoot);
  if (!(await configExists(repoRoot))) {
    const config = cloneDefaultConfig();
    const errors: string[] = [];
    const warnings: string[] = [];
    await validateSessionDirectory(repoRoot, config.sessionDir, options, errors, warnings);
    return {
      config,
      configPath,
      exists: false,
      migrated: false,
      errors,
      warnings,
    };
  }

  const raw = await readTextFileLimited(configPath, MAX_CONFIG_BYTES);
  let parsed: unknown;

  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Failed to parse ${CONFIG_FILE_NAME}: ${(error as Error).message}`, { cause: error });
  }

  const result = normalizeConfig(parsed);
  await validateSessionDirectory(repoRoot, result.config.sessionDir, options, result.errors, result.warnings);
  return {
    ...result,
    configPath,
    exists: true,
  };
}

function isPathInside(parentPath: string, candidatePath: string): boolean {
  const relative = path.relative(parentPath, candidatePath);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

export async function migrateConfigFile(repoRoot: string, options?: ConfigLoadOptions): Promise<ConfigLoadResult> {
  if (!(await configExists(repoRoot))) {
    throw new Error(`${CONFIG_FILE_NAME} does not exist. Run \`abb init\` first.`);
  }

  const result = await loadConfigWithMeta(repoRoot, options);
  if (result.errors.length > 0) {
    throw new Error(formatConfigProblems("Cannot migrate invalid Agent Black Box config", result.errors));
  }

  await writeTextFileAtomic(result.configPath, `${JSON.stringify(result.config, null, 2)}\n`);
  return result;
}

async function validateSessionDirectory(
  repoRoot: string,
  sessionDir: string,
  options: ConfigLoadOptions | undefined,
  errors: string[],
  warnings: string[]
): Promise<void> {
  if (isNetworkPath(sessionDir)) {
    errors.push("sessionDir must not use a network or UNC path.");
    return;
  }

  const resolvedRepoRoot = await realpath(repoRoot);
  const resolvedSessionDir = path.resolve(resolvedRepoRoot, sessionDir);
  const existingAncestor = await findExistingAncestor(resolvedSessionDir);
  const canonicalAncestor = await realpath(existingAncestor);
  const staysInsideRepository =
    isPathInside(resolvedRepoRoot, path.dirname(resolvedSessionDir)) &&
    isPathInside(resolvedRepoRoot, canonicalAncestor);

  if (staysInsideRepository) {
    return;
  }

  if (!options?.allowExternalSessionDir) {
    errors.push(
      "sessionDir must stay inside the repository. Use --allow-external-session-dir only for a trusted local path."
    );
    return;
  }

  warnings.push("sessionDir is outside the repository and was explicitly allowed for this command.");
}

function isNetworkPath(value: string): boolean {
  return /^(?:\\\\|\/\/)/.test(value) || /^\\\\\?\\UNC\\/i.test(value);
}

async function findExistingAncestor(candidatePath: string): Promise<string> {
  let currentPath = candidatePath;
  while (!(await pathExists(currentPath))) {
    const parentPath = path.dirname(currentPath);
    if (parentPath === currentPath) {
      return currentPath;
    }
    currentPath = parentPath;
  }
  return currentPath;
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
      warnings,
    };
  }

  const knownKeys = new Set([
    "$schema",
    "configVersion",
    "sessionDir",
    "exclude",
    "riskPatterns",
    "maxFileSizeKb",
    "retention",
  ]);
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
    maxFileSizeKb: maxFileSizeOrDefault(parsed.maxFileSizeKb, warnings),
    ...normalizeRetention(parsed.retention, errors),
  };

  return {
    config,
    migrated,
    errors,
    warnings,
  };
}

function cloneDefaultConfig(): AgentBlackBoxConfig {
  return {
    ...DEFAULT_CONFIG,
    exclude: [...DEFAULT_CONFIG.exclude],
    riskPatterns: [...DEFAULT_CONFIG.riskPatterns],
  };
}

function normalizeRetention(value: unknown, errors: string[]): Pick<AgentBlackBoxConfig, "retention"> {
  if (value === undefined) {
    return {};
  }
  if (!isRecord(value)) {
    errors.push("retention must be an object.");
    return {};
  }
  const knownRetentionKeys = new Set(["days", "keep", "archiveDir"]);
  for (const key of Object.keys(value)) {
    if (!knownRetentionKeys.has(key)) {
      errors.push(`Unknown retention key "${key}".`);
    }
  }
  for (const key of ["days", "keep"] as const) {
    const count = value[key];
    if (count !== undefined && (!Number.isSafeInteger(count) || Number(count) < 1 || Number(count) > 100_000)) {
      errors.push(`retention.${key} must be an integer between 1 and 100000.`);
    }
  }
  if (value.archiveDir !== undefined && (typeof value.archiveDir !== "string" || !value.archiveDir.trim())) {
    errors.push("retention.archiveDir must be a non-empty local path.");
  }
  if (errors.length > 0) {
    return {};
  }
  return {
    retention: {
      ...(value.days === undefined ? {} : { days: Number(value.days) }),
      ...(value.keep === undefined ? {} : { keep: Number(value.keep) }),
      ...(value.archiveDir === undefined ? {} : { archiveDir: String(value.archiveDir) }),
    },
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
