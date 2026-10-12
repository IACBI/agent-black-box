import { spawn } from "node:child_process";
import { realpath, rename, stat } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { loadConfig, type ConfigLoadOptions } from "../config/config.js";
import { requireRepositoryRoot } from "../git/git.js";
import { appendCommandEvent, inspectSessionRecoveryState, registerInFlightCommand } from "../session/sessionManager.js";
import { removeFileIfExists } from "../utils/files.js";
import { resolveWindowsExecutable } from "../utils/executables.js";
import { isPathInside, toRepoRelative } from "../utils/paths.js";
import { redactKnownSecretTokens } from "../risks/secretDetector.js";
import {
  compileSecretRules,
  NO_SECRET_RULES,
  redactCustomSecretPatterns,
  type CompiledSecretRules,
} from "../risks/secretRules.js";

const SENSITIVE_PATTERN =
  /(api[_-]?key|secret|token|password|passwd|passphrase|pwd|credential|private[_-]?key|client[_-]?secret|access[_-]?key|authorization|cookie)/i;
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
  const secretRules = compileSecretRules(config);
  const redactedCommand = formatCommand(redactCommandParts(normalizedCommandParts, secretRules));

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
      ...optionalMetadata("label", options.label, secretRules),
      ...optionalMetadata("group", options.group, secretRules),
      ...optionalMetadata("phase", options.phase, secretRules),
      exitCode: result.exitCode,
      durationMs: Math.round(performance.now() - startedAtMonotonic),
      ...(result.error ? { error: result.error } : {}),
    });
    recorded = true;
    return result.exitCode ?? 1;
  } catch (error) {
    // Preserve capture-loss evidence without leaving a finished command tied to a live wrapper PID.
    const failedMarker = path.join(
      path.dirname(inFlightMarker),
      path.basename(inFlightMarker).replace("command-inflight-", "command-failed-")
    );
    try {
      await rename(inFlightMarker, failedMarker);
    } catch (markerError) {
      throw new AggregateError(
        [error, markerError],
        "Command capture failed and its failure marker could not be saved.",
        { cause: markerError }
      );
    }
    throw error;
  } finally {
    if (recorded) {
      await releaseCompletedCommandMarker(inFlightMarker);
    }
  }
}

async function releaseCompletedCommandMarker(inFlightMarker: string): Promise<void> {
  try {
    await removeFileIfExists(inFlightMarker);
  } catch (cleanupError) {
    const completedMarker = path.join(
      path.dirname(inFlightMarker),
      path.basename(inFlightMarker).replace("command-inflight-", "command-completed-")
    );
    try {
      await rename(inFlightMarker, completedMarker);
    } catch (markerError) {
      throw new AggregateError(
        [cleanupError, markerError],
        "Command was recorded, but its completion marker could not be released.",
        { cause: markerError }
      );
    }
    throw cleanupError;
  }
}

export async function resolveRunCwd(repoRoot: string, requestedCwd?: string): Promise<string> {
  if (!requestedCwd) {
    return repoRoot;
  }

  const resolved = path.resolve(repoRoot, requestedCwd);

  if (!isPathInside(repoRoot, resolved)) {
    throw new Error("--cwd must stay inside the repository.");
  }

  const stats = await stat(resolved);
  if (!stats.isDirectory()) {
    throw new Error(`--cwd must point to a directory: ${requestedCwd}`);
  }

  const [physicalRepoRoot, physicalRunCwd] = await Promise.all([realpath(repoRoot), realpath(resolved)]);
  if (!isPathInside(physicalRepoRoot, physicalRunCwd)) {
    throw new Error("--cwd must stay inside the repository, including through symbolic links.");
  }

  return resolved;
}

export function normalizeCommandParts(parts: string[]): string[] {
  return parts[0] === "--" ? parts.slice(1) : parts;
}

export function redactCommandParts(parts: string[], secretRules: CompiledSecretRules = NO_SECRET_RULES): string[] {
  const redacted: string[] = [];
  const commandIndex = findWrappedCommandIndex(parts);
  const toolFlags = commandIndex === null ? null : findToolFlagRule(parts, commandIndex);
  if (commandIndex === null || toolFlags === null) {
    // Unknown wrapper/global options can change command or credential argument boundaries.
    return parts.map((part, index) => (index === 0 ? scrubCommandPart(part, secretRules) : "<redacted>"));
  }
  const toolRule = toolFlags?.rule;
  let redactNext = false;

  for (const [index, part] of parts.entries()) {
    if (part.length > MAX_COMMAND_PART_LENGTH + 256) {
      redacted.push("<redacted>");
      redactNext = !redactNext && part.startsWith("--") && SENSITIVE_PATTERN.test(part.slice(0, 256));
      continue;
    }
    if (redactNext) {
      redacted.push("<redacted>");
      redactNext = false;
      continue;
    }

    if (toolFlags && index > toolFlags.commandIndex && toolRule) {
      if (toolRule.valueFollows.has(part)) {
        redacted.push(part);
        redactNext = true;
        continue;
      }
      const attached = toolRule.attachedValue.exec(part);
      if (attached) {
        redacted.push(`${attached[1]}<redacted>`);
        continue;
      }
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
      redacted.push(scrubCommandPart(redactedUrl, secretRules));
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

    redacted.push(scrubCommandPart(part, secretRules));
  }

  return redacted;
}

interface ToolFlagRule {
  /** Flags whose next argument is a credential. */
  valueFollows: ReadonlySet<string>;
  /** Flags that carry the credential in the same argument; group 1 is the part to keep. */
  attachedValue: RegExp;
}

const MYSQL_FAMILY: ToolFlagRule = { valueFollows: new Set(), attachedValue: /^(-p)(?=.)/ };
const TOOL_FLAG_RULES: Record<string, ToolFlagRule> = {
  curl: {
    valueFollows: new Set(["-u", "--user", "-U", "--proxy-user", "--oauth2-bearer", "--pass"]),
    attachedValue: /^(--(?:(?:proxy-)?user|oauth2-bearer|pass)=|-[uU](?=.))/,
  },
  mysql: MYSQL_FAMILY,
  mysqladmin: MYSQL_FAMILY,
  mysqldump: MYSQL_FAMILY,
  mariadb: MYSQL_FAMILY,
  "redis-cli": { valueFollows: new Set(["-a", "--pass"]), attachedValue: /^(--pass=)/ },
  sshpass: { valueFollows: new Set(["-p"]), attachedValue: /^(-p)(?=.)/ },
  docker: { valueFollows: new Set(["-p"]), attachedValue: /^(-p=?)(?=.)/ },
  podman: { valueFollows: new Set(["-p"]), attachedValue: /^(-p=?)(?=.)/ },
};

/**
 * Short credential flags (`curl -u`, `mysql -pSECRET`) cannot be recognised by name, so they are matched per
 * tool. `docker -p` publishes a port everywhere except `login`, hence the subcommand check.
 */
function findToolFlagRule(
  parts: readonly string[],
  commandIndex: number
): { rule: ToolFlagRule; commandIndex: number } | null | undefined {
  const executable = executableName(parts[commandIndex] ?? "");
  const rule = Object.hasOwn(TOOL_FLAG_RULES, executable) ? TOOL_FLAG_RULES[executable] : undefined;
  if (executable === "docker" || executable === "podman") {
    const subcommandIndex = findOptionOperandIndex(parts, commandIndex + 1, CONTAINER_GLOBAL_OPTIONS[executable]!);
    if (subcommandIndex === null) return null;
    if (parts[subcommandIndex] !== "login") return undefined;
    commandIndex = subcommandIndex;
  }
  return rule ? { rule, commandIndex } : undefined;
}

const MAX_WRAPPER_ARGUMENTS = 128;
const MAX_COMMAND_WRAPPERS = 8;

interface CommandPrefixOptions {
  flags: ReadonlySet<string>;
  valueFlags: ReadonlySet<string>;
  optionalValueFlags?: ReadonlySet<string>;
  booleanValues?: boolean;
}

const WRAPPER_OPTIONS: Record<string, CommandPrefixOptions> = {
  sudo: {
    flags: new Set([
      "A",
      "b",
      "E",
      "H",
      "K",
      "k",
      "n",
      "P",
      "S",
      "--askpass",
      "--background",
      "--preserve-env",
      "--set-home",
      "--reset-timestamp",
      "--remove-timestamp",
      "--non-interactive",
      "--preserve-groups",
      "--stdin",
    ]),
    valueFlags: new Set([
      "u",
      "g",
      "h",
      "p",
      "C",
      "D",
      "R",
      "T",
      "r",
      "t",
      "--user",
      "--group",
      "--host",
      "--prompt",
      "--close-from",
      "--chdir",
      "--chroot",
      "--command-timeout",
      "--role",
      "--type",
    ]),
    optionalValueFlags: new Set(["--preserve-env"]),
  },
  nohup: { flags: new Set(), valueFlags: new Set() },
  nice: { flags: new Set(), valueFlags: new Set(["n", "--adjustment"]) },
  timeout: {
    flags: new Set(["f", "p", "v", "--foreground", "--preserve-status", "--verbose"]),
    valueFlags: new Set(["k", "s", "--kill-after", "--signal"]),
  },
};

const CONTAINER_GLOBAL_OPTIONS: Record<string, CommandPrefixOptions> = {
  docker: {
    flags: new Set(["D", "--debug", "--tls", "--tlsverify"]),
    valueFlags: new Set([
      "c",
      "H",
      "l",
      "--config",
      "--context",
      "--host",
      "--log-level",
      "--tlscacert",
      "--tlscert",
      "--tlskey",
    ]),
    booleanValues: true,
  },
  podman: {
    flags: new Set(["r", "--remote", "--syslog", "--transient-store"]),
    valueFlags: new Set([
      "c",
      "--cdi-spec-dir",
      "--cgroup-manager",
      "--config",
      "--conmon",
      "--connection",
      "--events-backend",
      "--hooks-dir",
      "--identity",
      "--imagestore",
      "--log-level",
      "--module",
      "--network-config-dir",
      "--out",
      "--root",
      "--runroot",
      "--runtime",
      "--runtime-flag",
      "--ssh",
      "--storage-driver",
      "--storage-opt",
      "--tls-ca",
      "--tls-cert",
      "--tls-details",
      "--tls-key",
      "--tmpdir",
      "--url",
      "--volumepath",
    ]),
    booleanValues: true,
  },
};

/** Parse only explicit, bounded argv. Unknown options and shell modes stay opaque. */
function findOptionOperandIndex(parts: readonly string[], start: number, options: CommandPrefixOptions): number | null {
  let index = start;
  while (index < parts.length) {
    if (!isBoundedWrapperOperand(parts, index)) return null;
    const part = parts[index]!;
    if (part === "--") return index + 1;
    if (!part.startsWith("-")) return index;
    if (part.startsWith("--")) {
      const separator = part.indexOf("=");
      const flag = separator < 0 ? part : part.slice(0, separator);
      if (options.flags.has(flag)) {
        if (
          separator >= 0 &&
          !options.optionalValueFlags?.has(flag) &&
          !(options.booleanValues && /^(?:true|false|0|1)$/.test(part.slice(separator + 1)))
        )
          return null;
        index += 1;
        continue;
      }
      if (!options.valueFlags.has(flag)) return null;
      if (separator >= 0) {
        index += 1;
        continue;
      }
      if (!isBoundedWrapperOperand(parts, index + 1)) return null;
      index += 2;
      continue;
    }
    if (part === "-") return null;
    let consumesNext = false;
    for (let offset = 1; offset < part.length; offset += 1) {
      const flag = part[offset]!;
      if (options.flags.has(flag)) continue;
      if (!options.valueFlags.has(flag)) return null;
      consumesNext = offset === part.length - 1;
      break;
    }
    if (consumesNext && !isBoundedWrapperOperand(parts, index + 1)) return null;
    index += consumesNext ? 2 : 1;
  }
  return index;
}

function executableName(command: string): string {
  return path
    .basename(command)
    .toLowerCase()
    .replace(/\.(?:exe|cmd|bat)$/, "");
}

/** Resolve explicit wrapper argv only; split strings and shell modes are intentionally opaque. */
function findWrappedCommandIndex(parts: readonly string[]): number | null {
  let commandIndex = 0;
  let wrappers = 0;
  while (true) {
    const executable = executableName(parts[commandIndex] ?? "");
    const options = Object.hasOwn(WRAPPER_OPTIONS, executable) ? WRAPPER_OPTIONS[executable] : undefined;
    if (executable !== "env" && !options) return commandIndex;
    wrappers += 1;
    if (wrappers > MAX_COMMAND_WRAPPERS) return null;
    let childIndex =
      executable === "env"
        ? findEnvCommandIndex(parts, commandIndex + 1)
        : findOptionOperandIndex(parts, commandIndex + 1, options!);
    if (childIndex === null) return null;
    if (executable === "sudo") {
      while (parts[childIndex]?.includes("=")) {
        if (!isBoundedWrapperOperand(parts, childIndex)) return null;
        childIndex += 1;
      }
    } else if (executable === "timeout") {
      if (
        !isBoundedWrapperOperand(parts, childIndex) ||
        !/^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?[smhd]?$/.test(parts[childIndex]!)
      )
        return null;
      childIndex += 1;
    }
    if (childIndex < parts.length && !isBoundedWrapperOperand(parts, childIndex)) return null;
    commandIndex = childIndex;
  }
}

function findEnvCommandIndex(parts: readonly string[], start: number): number | null {
  let index = start;
  while (index < parts.length) {
    const part = parts[index]!;
    if (index >= MAX_WRAPPER_ARGUMENTS || part.length > MAX_COMMAND_PART_LENGTH + 256) return null;
    if (part === "--") {
      index += 1;
      break;
    }
    if (part === "-" || !part.startsWith("-")) break;
    if (part.startsWith("--")) {
      if (part === "--ignore-environment" || part === "--debug") {
        index += 1;
        continue;
      }
      const valueOption = /^(--unset|--chdir|--argv0)(=|$)/.exec(part);
      if (!valueOption) return null;
      if (valueOption[2] === "=") {
        index += 1;
        continue;
      }
      if (!isBoundedWrapperOperand(parts, index + 1)) return null;
      index += 2;
      continue;
    }
    // Short options can be grouped; a value-taking option consumes the rest of its group.
    let consumesNext = false;
    for (let offset = 1; offset < part.length; offset += 1) {
      const option = part[offset]!;
      if (option === "i" || option === "v") continue;
      if (option !== "u" && option !== "C" && option !== "a") return null;
      consumesNext = offset === part.length - 1;
      break;
    }
    if (consumesNext && !isBoundedWrapperOperand(parts, index + 1)) return null;
    index += consumesNext ? 2 : 1;
  }
  if (parts[index] === "-") index += 1;
  // GNU env stops parsing options before assignments, even when an assignment is followed by '--'.
  while (index < parts.length) {
    if (!isBoundedWrapperOperand(parts, index)) return null;
    if (!parts[index]!.includes("=")) return index;
    index += 1;
  }
  return index;
}

function isBoundedWrapperOperand(parts: readonly string[], index: number): boolean {
  return (
    index < MAX_WRAPPER_ARGUMENTS && parts[index] !== undefined && parts[index]!.length <= MAX_COMMAND_PART_LENGTH + 256
  );
}

const EMBEDDED_SCRIPT_MARKER = /[\s;&|]/;
// The bounded prefix can end inside a quoted credential; redact its remaining partial value too.
const EMBEDDED_ASSIGNMENT = /(?<![A-Za-z0-9_])([A-Za-z_][A-Za-z0-9_-]*)=("[^"]*(?:"|$)|'[^']*(?:'|$)|[^\s"';&|]+)/g;
const EMBEDDED_HEADER = /(?<![A-Za-z0-9_-])([A-Za-z][A-Za-z0-9-]*)(\s*:\s*)([^"'\n;&|]+)/g;
const EMBEDDED_FLAG = /(?<![A-Za-z0-9_-])(--[A-Za-z0-9_-]+)(=|\s+)("[^"]*(?:"|$)|'[^']*(?:'|$)|[^\s"';&|]+)/g;

/**
 * Last line of defence for one argument: credentials embedded in a script string (`sh -c "export TOKEN=x"`),
 * provider token shapes with no name to give them away, and the repository's own patterns.
 */
function scrubCommandPart(part: string, secretRules: CompiledSecretRules): string {
  let scrubbed = part.length > MAX_COMMAND_PART_LENGTH + 256 ? part.slice(0, MAX_COMMAND_PART_LENGTH + 256) : part;
  if (EMBEDDED_SCRIPT_MARKER.test(scrubbed)) {
    const hideSensitive = (match: string, key: string, separator: string): string =>
      SENSITIVE_PATTERN.test(key) ? `${key}${separator}<redacted>` : match;
    scrubbed = scrubbed
      .replace(EMBEDDED_ASSIGNMENT, (match, key: string) => hideSensitive(match, key, "="))
      .replace(EMBEDDED_HEADER, (match, key: string, separator: string) => hideSensitive(match, key, separator))
      .replace(EMBEDDED_FLAG, (match, key: string, separator: string) => hideSensitive(match, key, separator));
  }
  return truncateCommandPart(redactCustomSecretPatterns(secretRules, redactKnownSecretTokens(scrubbed)));
}

export function formatCommand(parts: string[]): string {
  const formatted = parts.map(quoteCommandPart).join(" ");
  return formatted.length <= MAX_RECORDED_COMMAND_LENGTH
    ? formatted
    : `${formatted.slice(0, MAX_RECORDED_COMMAND_LENGTH - 14)}…<truncated>`;
}

function optionalMetadata<K extends "label" | "group" | "phase">(
  key: K,
  value: string | undefined,
  secretRules: CompiledSecretRules
): Partial<Record<K, string>> {
  if (value && value.length > MAX_COMMAND_PART_LENGTH + 256) {
    return { [key]: "<redacted>" } as Partial<Record<K, string>>;
  }
  const normalized = value?.trim().replace(/\s+/g, " ");
  if (!normalized) {
    return {};
  }
  if (redactSensitiveJson(normalized) !== normalized) {
    return { [key]: "<redacted>" } as Partial<Record<K, string>>;
  }
  for (const match of normalized.matchAll(/(?:^|\s)([A-Za-z_][A-Za-z0-9_-]*)\s*[:=]/g)) {
    if (SENSITIVE_PATTERN.test(match[1] ?? "")) {
      return { [key]: "<redacted>" } as Partial<Record<K, string>>;
    }
  }
  const redacted = redactCommandParts(normalized.split(" "), secretRules).join(" ");
  return { [key]: redacted.slice(0, 80) } as Partial<Record<K, string>>;
}

function spawnCommand(commandParts: string[], cwd: string): Promise<{ exitCode: number | null; error?: string }> {
  const [command = "", ...args] = commandParts;
  const executable = resolveExecutable(command, cwd);
  if (executable === null) {
    return Promise.resolve({ exitCode: null, error: formatSpawnError({ code: "ENOENT" } as NodeJS.ErrnoException) });
  }

  return new Promise((resolve) => {
    let spawnTarget: ReturnType<typeof getSpawnTarget>;
    try {
      spawnTarget = getSpawnTarget(executable, args);
    } catch {
      resolve({ exitCode: null, error: "Windows command script arguments could not be passed safely." });
      return;
    }
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(spawnTarget.command, spawnTarget.args, {
        cwd,
        shell: false,
        stdio: "inherit",
        windowsVerbatimArguments: spawnTarget.windowsVerbatimArguments,
      });
    } catch (error) {
      resolve({ exitCode: null, error: formatSpawnError(error as NodeJS.ErrnoException) });
      return;
    }
    let settled = false;

    child.once("error", (error: NodeJS.ErrnoException) => {
      if (!settled) {
        settled = true;
        resolve({ exitCode: null, error: formatSpawnError(error) });
      }
    });

    child.once("close", (code) => {
      if (!settled) {
        settled = true;
        resolve({ exitCode: code });
      }
    });
  });
}

/**
 * On Windows a bare command name is resolved through absolute PATH entries only, so an executable
 * or script inside the repository cannot shadow a tool. Returns null when a bare name is not found.
 */
function resolveExecutable(command: string, cwd: string): string | null {
  // Invalid names are passed through so spawn reports its own validation error.
  if (process.platform !== "win32" || command === "" || command.includes("\0")) {
    return command;
  }

  const hasDirectory = /[\\/]/.test(command);
  if (hasDirectory && path.extname(command) !== "") {
    return command;
  }

  return resolveWindowsExecutable(command, cwd) ?? (hasDirectory ? command : null);
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
    const configuredInterpreter = process.env.ComSpec;
    let interpreter: string | null;
    if (configuredInterpreter && path.isAbsolute(configuredInterpreter)) {
      interpreter = configuredInterpreter;
    } else {
      if (configuredInterpreter && /[\\/]/.test(configuredInterpreter)) {
        throw new Error("Windows command interpreter paths must be absolute.");
      }
      interpreter = resolveWindowsExecutable(configuredInterpreter || "cmd.exe", process.cwd());
    }
    if (!interpreter) {
      throw new Error("A trusted Windows command interpreter was not found.");
    }

    return {
      command: interpreter,
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
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(part)) {
    return part;
  }

  try {
    const url = new URL(part);
    let changed = false;
    // A bare username is only a credential for HTTP(S) (e.g. token@host); ssh://git@host is not secret.
    if (url.username && /^https?:$/.test(url.protocol)) {
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
  const keyPattern = /"((?:[^"\\]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4})){1,128})"\s*:/g;
  for (const match of part.matchAll(keyPattern)) {
    let key = match[1] ?? "";
    if (key.includes("\\")) {
      try {
        key = JSON.parse(`"${key}"`) as string;
      } catch {
        // Invalid JSON string escapes do not identify a property name.
        continue;
      }
    }
    if (SENSITIVE_PATTERN.test(key)) {
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
