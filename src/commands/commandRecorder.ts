import { spawn } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { loadConfig } from "../config/config.js";
import { requireRepositoryRoot } from "../git/git.js";
import { appendCommandEvent, isProcessRunning, readActiveSession } from "../session/sessionManager.js";
import { normalizePath, toRepoRelative } from "../utils/paths.js";

const SENSITIVE_PATTERN =
  /(api[_-]?key|secret|token|password|passwd|private[_-]?key|client[_-]?secret|access[_-]?key|authorization|cookie)/i;
const MAX_COMMAND_PART_LENGTH = 4096;
const MAX_RECORDED_COMMAND_LENGTH = 32_768;

export interface RecordCommandOptions {
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
  const config = await loadConfig(repoRoot);
  const active = await readActiveSession(repoRoot, config);

  if (!active) {
    throw new Error("No active Agent Black Box session. Run `abb start` before `abb run`.");
  }

  if (!isProcessRunning(active.pid)) {
    throw new Error(`Active session ${active.id} appears stale. Run \`abb stop\` to finalize it first.`);
  }

  const runCwd = await resolveRunCwd(repoRoot, options.cwd);
  const startedAtDate = new Date();
  const startedAt = startedAtDate.toISOString();
  const redactedCommand = formatCommand(redactCommandParts(normalizedCommandParts));

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
    durationMs: endedAtDate.getTime() - startedAtDate.getTime(),
    ...(result.error ? { error: result.error } : {}),
  });

  return result.exitCode ?? 1;
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
      const separator = part.includes("=") ? "=" : ":";
      const [key] = part.split(separator, 1);
      redacted.push(`${key}${separator}<redacted>`);
      continue;
    }

    const nestedAssignment = redactNestedSensitiveAssignment(part);
    if (nestedAssignment) {
      redacted.push(nestedAssignment);
      continue;
    }

    const redactedUrl = redactSensitiveUrl(part);
    if (redactedUrl !== part) {
      redacted.push(redactedUrl);
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

  return { [key]: normalized.slice(0, 80) } as Partial<Record<K, string>>;
}

function spawnCommand(commandParts: string[], cwd: string): Promise<{ exitCode: number | null; error?: string }> {
  const [command, ...args] = commandParts;

  return new Promise((resolve) => {
    const spawnWithFallback = (targetCommand: string, fallbackIndex: number): void => {
      const spawnTarget = getSpawnTarget(targetCommand, args);
      const child = spawn(spawnTarget.command, spawnTarget.args, {
        cwd,
        shell: false,
        stdio: "inherit",
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

function getSpawnTarget(command: string, args: string[]): { command: string; args: string[] } {
  if (process.platform === "win32" && /\.(cmd|bat)$/i.test(command)) {
    return {
      command: process.env.ComSpec ?? "cmd.exe",
      args: ["/d", "/v:off", "/s", "/c", buildWindowsCommandLine([command, ...args])],
    };
  }

  return { command, args };
}

export function buildWindowsCommandLine(parts: string[]): string {
  return parts.map(quoteWindowsCommandPart).join(" ");
}

function quoteWindowsCommandPart(part: string): string {
  const escaped = part.replace(/([&|<>^"%!])/g, "^$1");

  if (escaped.length === 0 || /\s/.test(escaped)) {
    return `"${escaped}"`;
  }

  return escaped;
}

function isSensitiveAssignment(part: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*(=|:).+/.test(part) && SENSITIVE_PATTERN.test(part.split(/=|:/, 1)[0] ?? "");
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

  const nestedSeparator = nested.includes("=") ? "=" : ":";
  const [key] = nested.split(nestedSeparator, 1);
  return `${prefix}${key}${nestedSeparator}<redacted>`;
}

function redactSensitiveUrl(part: string): string {
  if (!/^https?:\/\//i.test(part)) {
    return part;
  }

  try {
    const url = new URL(part);
    let changed = false;
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
