import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import path from "node:path";
import { loadConfig } from "../config/config.js";
import { requireRepositoryRoot } from "../git/git.js";
import { appendCommandEvent, isProcessRunning, readActiveSession } from "../session/sessionManager.js";
import { normalizePath, toRepoRelative } from "../utils/paths.js";

const SENSITIVE_PATTERN = /(api[_-]?key|secret|token|password|passwd|private[_-]?key|client[_-]?secret|access[_-]?key)/i;

export interface RecordCommandOptions {
  cwd?: string;
  label?: string;
  group?: string;
  phase?: string;
}

export async function recordAndRunCommand(commandParts: string[], cwd: string, options: RecordCommandOptions = {}): Promise<number> {
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
    ...(result.error ? { error: result.error } : {})
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

    redacted.push(part);
  }

  return redacted;
}

export function formatCommand(parts: string[]): string {
  return parts.map(quoteCommandPart).join(" ");
}

function optionalMetadata<K extends "label" | "group" | "phase">(key: K, value: string | undefined): Partial<Record<K, string>> {
  const normalized = value?.trim().replace(/\s+/g, " ");
  if (!normalized) {
    return {};
  }

  return { [key]: normalized.slice(0, 80) } as Partial<Record<K, string>>;
}

function spawnCommand(commandParts: string[], cwd: string): Promise<{ exitCode: number | null; error?: string }> {
  const [command, ...args] = commandParts;
  const spawnTarget = getSpawnTarget(command, args);

  return new Promise((resolve) => {
    const child = spawn(spawnTarget.command, spawnTarget.args, {
      cwd,
      shell: false,
      stdio: "inherit"
    });

    child.once("error", (error) => {
      resolve({ exitCode: null, error: error.message });
    });

    child.once("close", (code) => {
      resolve({ exitCode: code });
    });
  });
}

function getSpawnTarget(command: string, args: string[]): { command: string; args: string[] } {
  if (process.platform === "win32" && /\.(cmd|bat)$/i.test(command)) {
    return {
      command: process.env.ComSpec ?? "cmd.exe",
      args: ["/d", "/s", "/c", buildWindowsCommandLine([command, ...args])]
    };
  }

  return { command, args };
}

export function buildWindowsCommandLine(parts: string[]): string {
  return parts.map(quoteWindowsCommandPart).join(" ");
}

function quoteWindowsCommandPart(part: string): string {
  const escaped = part.replace(/([&|<>^"%])/g, "^$1");

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

function quoteCommandPart(part: string): string {
  if (/^[A-Za-z0-9_./:=@+-]+$/.test(part)) {
    return part;
  }

  return `"${part.replace(/(["\\$`])/g, "\\$1")}"`;
}
