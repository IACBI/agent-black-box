import { spawn } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { loadConfig, type ConfigLoadOptions } from "../config/config.js";
import { requireRepositoryRoot } from "../git/git.js";
import { appendCommandEvent, inspectSessionRecoveryState, registerInFlightCommand } from "../session/sessionManager.js";
import { removeFileIfExists } from "../utils/files.js";
import { normalizePath, toRepoRelative } from "../utils/paths.js";

const SENSITIVE_PATTERN =
  /(api[_-]?key|secret|token|password|passwd|private[_-]?key|client[_-]?secret|access[_-]?key|authorization|cookie)/i;
const MAX_COMMAND_PART_LENGTH = 4096;
const MAX_RECORDED_COMMAND_LENGTH = 32_768;

export interface RecordCommandOptions extends ConfigLoadOptions {
  cwd?: string;
  label?: string;
  group?: string;
  phase?: string;
}

export async function recordAndRunCommand(
  commandParts: string[],
  cwd: string,
  options: RecordCommandOptions = {}
): Promise<number> {
  const normalizedCommandParts = normalizeCommandParts(commandParts);

  if (normalizedCommandParts.length === 0) {
    throw new Error("Usage: abb run -- <command> [args...]");
  }

  const repoRoot = await requireRepositoryRoot(cwd);
  const config = await loadConfig(repoRoot, options);
  const recovery = await inspectSessionRecoveryState(repoRoot, config);
  const active = recovery.active;

  if (recovery.status === "no-active-session") {
    throw new Error("No active Agent Black Box session. Run `abb start` before `abb run`.");
  }

  if (recovery.status !== "active" || !active) {
    throw new Error(`${recovery.message} Run \`abb doctor\` before recording commands.`);
  }

  const runCwd = await resolveRunCwd(repoRoot, options.cwd);
  const startedAtMonotonic = performance.now();
  const startedAtDate = new Date();
  const startedAt = startedAtDate.toISOString();
  const redactedCommand = formatCommand(redactCommandParts(normalizedCommandParts));

  const inFlightMarker = await registerInFlightCommand(active);
  let recorded = false;
  try {
    const result = await spawnCommand(normalizedCommandParts, runCwd);
    const endedAtDate = new Date();

    await appendCommandEvent(active, {
      startedAt,
      endedAt: endedAtDate.toISOString(),
      command: redactedCommand,
      cwd: toRepoRelative(repoRoot, runCwd) || ".",
      ...optionalMetadata("label", options.label),
      ...optionalMetadata("group", options.group),
      ...optionalMetadata("phase", options.phase),
      exitCode: result.exitCode,
      durationMs: Math.round(performance.now() - startedAtMonotonic),
      ...(result.error ? { error: result.error } : {}),
    });
    recorded = true;
    return result.exitCode ?? 1;
  } finally {
    if (recorded) {
      await removeFileIfExists(inFlightMarker);
    }
  }
}

export async function resolveRunCwd(repoRoot: string, requestedCwd?: string): Promise<string> {
  if (!requestedCwd) {
    return repoRoot;
  }

  const resolved = path.resolve(repoRoot, requestedCwd);
  const relative = normalizePath(path.relative(repoRoot, resolved));

  if (relative === ".." || relative.startsWith("../") || path.isAbsolute(relative)) {
    throw new Error("--cwd must stay inside the repository.");
  }

  const stats = await stat(resolved);
  if (!stats.isDirectory()) {
    throw new Error(`--cwd must point to a directory: ${requestedCwd}`);
  }

  const [physicalRepoRoot, physicalRunCwd] = await Promise.all([realpath(repoRoot), realpath(resolved)]);
  const physicalRelative = normalizePath(path.relative(physicalRepoRoot, physicalRunCwd));
  if (physicalRelative === ".." || physicalRelative.startsWith("../") || path.isAbsolute(physicalRelative)) {
    throw new Error("--cwd must stay inside the repository, including through symbolic links.");
  }

  return resolved;
}

export function normalizeCommandParts(parts: string[]): string[] {
  return parts[0] === "--" ? parts.slice(1) : parts;
}

export function redactCommandParts(parts: string[]): string[] {
  const redacted: string[] = [];
  let redactNext = false;

  for (const part of parts) {
    if (redactNext) {
      redacted.push("<redacted>");
      redactNext = false;
      continue;
    }

    if (isSensitiveAssignment(part)) {
      redacted.push(`${part.slice(0, part.search(/[=:]/) + 1)}<redacted>`);
      continue;
    }

    const nestedAssignment = redactNestedSensitiveAssignment(part);
    if (nestedAssignment) {
      redacted.push(nestedAssignment);
      continue;
    }

    const redactedUrl = redactUrlPart(part);
    if (redactedUrl !== part) {
      redacted.push(redactedUrl);
      continue;
    }

    const redactedJson = redactSensitiveJson(part);
    if (redactedJson !== part) {
      redacted.push(redactedJson);
      continue;
    }

    if (isSensitiveFlagWithValue(part)) {
      const [flag] = part.split("=", 1);
      redacted.push(`${flag}=<redacted>`);
      continue;
    }

    if (isSensitiveFlag(part)) {
      redacted.push(part);
      redactNext = true;
      continue;
    }

    redacted.push(truncateCommandPart(part));
  }

  return redacted;
}

export function formatCommand(parts: string[]): string {
  const formatted = parts.map(quoteCommandPart).join(" ");
  return formatted.length <= MAX_RECORDED_COMMAND_LENGTH
    ? formatted
    : `${formatted.slice(0, MAX_RECORDED_COMMAND_LENGTH - 14)}…<truncated>`;
}

function optionalMetadata<K extends "label" | "group" | "phase">(
  key: K,
  value: string | undefined
): Partial<Record<K, string>> {
  const normalized = value?.trim().replace(/\s+/g, " ");
  if (!normalized) {
    return {};
  }
  if (redactSensitiveJson(normalized) !== normalized) {
    return { [key]: "<redacted>" } as Partial<Record<K, string>>;
  }
  for (const match of normalized.matchAll(/(?:^|\s)([A-Za-z_][A-Za-z0-9_-]*)\s*[:=]/g)) {
    if (SENSITIVE_PATTERN.test(match[1])) {
      return { [key]: "<redacted>" } as Partial<Record<K, string>>;
    }
  }
  const redacted = redactCommandParts(normalized.split(" ")).join(" ");
  return { [key]: redacted.slice(0, 80) } as Partial<Record<K, string>>;
}

function spawnCommand(commandParts: string[], cwd: string): Promise<{ exitCode: number | null; error?: string }> {
  const [command, ...args] = commandParts;

  return new Promise((resolve) => {
    const spawnWithFallback = (targetCommand: string, fallbackIndex: number): void => {
      let spawnTarget: ReturnType<typeof getSpawnTarget>;
      try {
        spawnTarget = getSpawnTarget(targetCommand, args);
      } catch {
        resolve({ exitCode: null, error: "Windows command script arguments could not be passed safely." });
        return;
      }
      const child = spawn(spawnTarget.command, spawnTarget.args, {
        cwd,
        shell: false,
        stdio: "inherit",
        windowsVerbatimArguments: spawnTarget.windowsVerbatimArguments,
      });
      let fallbackStarted = false;
      let settled = false;

      child.once("error", (error: NodeJS.ErrnoException) => {
        if (shouldTryWindowsScriptFallback(command, error, fallbackIndex)) {
          fallbackStarted = true;
          spawnWithFallback(`${command}${WINDOWS_SCRIPT_EXTENSIONS[fallbackIndex]}`, fallbackIndex + 1);
          return;
        }

        if (!settled) {
          settled = true;
          resolve({ exitCode: null, error: formatSpawnError(error) });
        }
      });

      child.once("close", (code) => {
        if (!fallbackStarted && !settled) {
          settled = true;
          resolve({ exitCode: code });
        }
      });
    };

    spawnWithFallback(command, 0);
  });
}

const WINDOWS_SCRIPT_EXTENSIONS = [".cmd", ".bat"] as const;

function shouldTryWindowsScriptFallback(
  originalCommand: string,
  error: NodeJS.ErrnoException,
  fallbackIndex: number
): boolean {
  return (
    process.platform === "win32" &&
    error.code === "ENOENT" &&
    path.extname(originalCommand) === "" &&
    fallbackIndex < WINDOWS_SCRIPT_EXTENSIONS.length
  );
}

function getSpawnTarget(
  command: string,
  args: string[]
): {
  command: string;
  args: string[];
  windowsVerbatimArguments?: boolean;
} {
  if (process.platform === "win32" && /\.(cmd|bat)$/i.test(command)) {
    return {
      command: process.env.ComSpec ?? "cmd.exe",
      args: ["/d", "/v:off", "/s", "/c", buildWindowsCommandLine([command, ...args])],
      windowsVerbatimArguments: true,
    };
  }

  return { command, args };
}

export function buildWindowsCommandLine(parts: string[]): string {
  if (parts.some((part) => /[%\r\n\0]/.test(part))) {
    throw new Error("Windows command script arguments cannot safely contain percent signs or line breaks.");
  }

  // /s /c removes the outer quotes. Keep the inner quotes intact for paths with spaces.
  return `"${parts.map(quoteWindowsCommandPart).join(" ")}"`;
}

function quoteWindowsCommandPart(part: string): string {
  if (part.length === 0 || /[\s&|<>^"!]/.test(part)) {
    let trailingBackslashStart = part.length;
    while (trailingBackslashStart > 0 && part[trailingBackslashStart - 1] === "\\") {
      trailingBackslashStart--;
    }
    const escaped =
      part.slice(0, trailingBackslashStart).replace(/"/g, '""') +
      "\\".repeat((part.length - trailingBackslashStart) * 2);
    return `"${escaped}"`;
  }

  return part;
}

function isSensitiveAssignment(part: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_-]*(=|:).+/.test(part) && SENSITIVE_PATTERN.test(part.split(/=|:/, 1)[0] ?? "");
}

function isSensitiveFlagWithValue(part: string): boolean {
  return /^--[^=]+=.+/.test(part) && SENSITIVE_PATTERN.test(part.split("=", 1)[0] ?? "");
}

function isSensitiveFlag(part: string): boolean {
  return /^--/.test(part) && SENSITIVE_PATTERN.test(part);
}

function redactNestedSensitiveAssignment(part: string): string | null {
  const separatorIndex = part.indexOf("=");
  if (separatorIndex < 0) {
    return null;
  }

  const prefix = part.slice(0, separatorIndex + 1);
  const nested = part.slice(separatorIndex + 1);
  if (!isSensitiveAssignment(nested)) {
    return null;
  }

  return `${prefix}${nested.slice(0, nested.search(/[=:]/) + 1)}<redacted>`;
}

function redactSensitiveUrl(part: string): string {
  if (!/^https?:\/\//i.test(part)) {
    return part;
  }

  try {
    const url = new URL(part);
    let changed = false;
    if (url.username) {
      url.username = "<redacted>";
      changed = true;
    }
    if (url.password) {
      url.password = "<redacted>";
      changed = true;
    }
    for (const key of [...url.searchParams.keys()]) {
      if (SENSITIVE_PATTERN.test(key)) {
        url.searchParams.set(key, "<redacted>");
        changed = true;
      }
    }
    return changed ? url.toString() : part;
  } catch {
    return part;
  }
}

function redactUrlPart(part: string): string {
  const separator = part.indexOf("=");
  if (separator > 0 && /^(?:--[A-Za-z0-9_-]+|[A-Za-z_][A-Za-z0-9_]*)$/.test(part.slice(0, separator))) {
    const prefix = part.slice(0, separator + 1);
    return `${prefix}${redactSensitiveUrl(part.slice(separator + 1))}`;
  }
  return redactSensitiveUrl(part);
}

function redactSensitiveJson(part: string): string {
  const keyPattern = /"([^"\\]{1,128})"\s*:/g;
  for (const match of part.matchAll(keyPattern)) {
    if (SENSITIVE_PATTERN.test(match[1])) {
      const separator = part.indexOf("=");
      const prefix = separator > 0 ? part.slice(0, separator + 1) : "";
      return /^--[A-Za-z0-9_-]+=$/.test(prefix) ? `${prefix}<redacted>` : "<redacted>";
    }
  }
  return part;
}

function truncateCommandPart(part: string): string {
  return part.length <= MAX_COMMAND_PART_LENGTH ? part : `${part.slice(0, MAX_COMMAND_PART_LENGTH - 14)}…<truncated>`;
}

function formatSpawnError(error: NodeJS.ErrnoException): string {
  return error.code ? `${error.code}: command could not be started.` : "Command could not be started.";
}

function quoteCommandPart(part: string): string {
  if (/^[A-Za-z0-9_./:=@+-]+$/.test(part)) {
    return part;
  }

  return `"${part.replace(/(["\\$`])/g, "\\$1")}"`;
}
