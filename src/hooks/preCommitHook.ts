import { constants } from "node:fs";
import { access, chmod, copyFile, lstat, mkdir, open, realpath, rename, rm } from "node:fs/promises";
import path from "node:path";
import { createGit } from "../git/executable.js";
import { readTextFileLimited, writeTextFileAtomic } from "../utils/files.js";
import { isPathInside } from "../utils/paths.js";
import { formatTerminalValue } from "../utils/terminal.js";

/** Marker on line 2 of every hook this module writes; it is how a managed hook is recognised. */
export const HOOK_MARKER = "# agent-black-box managed pre-commit hook v1";
/** Policy used when the caller does not choose one. */
export const DEFAULT_HOOK_POLICY = "new-secrets";
/** Suffix of the file a forced install moves a foreign hook to. */
export const HOOK_BACKUP_SUFFIX = ".pre-abb";

const POLICY_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
const POLICY_LINE_PREFIX = "# agent-black-box policy: ";
const EXTERNAL_STORAGE_LINE = "# agent-black-box allow-external-session-dir: true";
const FIRST_COMMIT_POLICY_LINE = "# agent-black-box first-commit: policy";
const MAX_HOOK_BYTES = 256 * 1024;
const HOOK_FILE_NAME = "pre-commit";

/** Explicit opt-ins persisted in a managed hook's fixed arguments and metadata. */
export interface HookScriptOptions {
  /** Authorize trusted local external session storage whenever this hook runs. Network paths remain blocked. */
  allowExternalSessionDir?: boolean;
  /** First-commit behavior: severity-high fallback by default, or the selected policy with all staged content new. */
  firstCommit?: "high" | "policy";
}

/** Options accepted by {@link installPreCommitHook}. */
export interface HookInstallOptions extends HookScriptOptions {
  /** Analysis policy the hook runs. Defaults to `new-secrets`; must match `[a-z][a-z0-9-]{0,63}`. */
  policy?: string;
  /** Back up an existing foreign `pre-commit` to `pre-commit.pre-abb` and replace it. */
  force?: boolean;
}

/** Outcome of {@link installPreCommitHook}. */
export interface HookInstallResult extends HookScriptOptions {
  /** `installed` for a new file, `updated` when a managed hook changed, `unchanged` when identical. */
  action: "installed" | "updated" | "unchanged";
  hookPath: string;
  policy: string;
  /** Present when a foreign hook was moved aside by a forced install. */
  backupPath?: string;
}

/** Outcome of {@link uninstallPreCommitHook}. */
export interface HookUninstallResult {
  /** `foreign` means a hook exists that this module did not write, so nothing was touched. */
  action: "removed" | "absent" | "foreign";
  hookPath: string;
  /** Present when a previously backed-up hook was restored. */
  restoredFrom?: string;
}

/** State of the `pre-commit` entry in the hooks directory. */
export type HookState = "absent" | "managed" | "managed-outdated" | "foreign";

/** Result of {@link getPreCommitHookStatus}. */
export interface HookStatus extends HookScriptOptions {
  state: HookState;
  hookPath: string;
  /** Policy parsed from the managed marker; absent for `absent`/`foreign` or an unreadable marker. */
  policy?: string;
}

/**
 * Builds the managed hook script (POSIX sh, LF endings).
 * Throws when `policy` is not a plain profile name, so no caller text can reach the shell.
 */
export function buildPreCommitHookScript(policy: string, options: HookScriptOptions = {}): string {
  assertValidPolicy(policy);
  const scriptOptions = normalizeHookScriptOptions(options);
  const abbCommand = scriptOptions.allowExternalSessionDir ? "abb --allow-external-session-dir" : "abb";
  return [
    "#!/bin/sh",
    HOOK_MARKER,
    `${POLICY_LINE_PREFIX}${policy}`,
    ...(scriptOptions.allowExternalSessionDir ? [EXTERNAL_STORAGE_LINE] : []),
    ...(scriptOptions.firstCommit === "policy" ? [FIRST_COMMIT_POLICY_LINE] : []),
    "# Installed by `abb hook install`; remove it with `abb hook uninstall`.",
    "#",
    "# Fail-open on purpose: a machine without `abb` (fresh clone, GUI Git client, different",
    "# Node setup) must still be able to commit. CI is the enforcement point, not this hook.",
    "if ! command -v abb >/dev/null 2>&1; then",
    '  echo "agent-black-box: abb was not found on PATH; skipping the pre-commit check." >&2',
    "  exit 0",
    "fi",
    scriptOptions.firstCommit === "policy"
      ? "# The first commit has no baseline; its policy treats all staged content as new."
      : "# The first commit has no baseline, so it falls back to a severity threshold.",
    "if git rev-parse --verify --quiet HEAD >/dev/null 2>&1; then",
    `  exec ${abbCommand} analyze --staged --baseline HEAD --policy ${policy}`,
    "fi",
    scriptOptions.firstCommit === "policy"
      ? `exec ${abbCommand} analyze --staged --initial --policy ${policy}`
      : `exec ${abbCommand} analyze --staged --fail-on high`,
    "",
  ].join("\n");
}

/**
 * Installs (or updates) the managed pre-commit hook in the repository's effective hooks directory.
 * Refuses foreign hooks unless `force` is set, hooks directories outside the repository, and links.
 */
export async function installPreCommitHook(
  repoRoot: string,
  options: HookInstallOptions = {}
): Promise<HookInstallResult> {
  const policy = options.policy ?? DEFAULT_HOOK_POLICY;
  const script = buildPreCommitHookScript(policy, options);
  const scriptOptions = normalizeHookScriptOptions(options);
  const hookPath = path.join(await resolveHooksDirectory(repoRoot), HOOK_FILE_NAME);
  return withHookMutationLock(hookPath, () =>
    installHookAtPath(hookPath, policy, script, scriptOptions, options.force)
  );
}

async function installHookAtPath(
  hookPath: string,
  policy: string,
  script: string,
  scriptOptions: HookScriptOptions,
  force: boolean | undefined
): Promise<HookInstallResult> {
  const entry = await inspectHookEntry(hookPath);

  if (entry.kind === "unsafe") {
    throw new Error(`Refusing to modify ${formatTerminalValue(hookPath)}: ${entry.reason}.`);
  }

  if (entry.kind === "absent") {
    try {
      await writeExecutable(hookPath, script, false);
    } catch (error) {
      if ((error as NodeJS.ErrnoException | undefined)?.code === "EEXIST") {
        throw new Error(
          `A pre-commit hook appeared during installation at ${formatTerminalValue(hookPath)}; left it untouched. Inspect it and retry.`,
          { cause: error }
        );
      }
      throw error;
    }
    return { action: "installed", hookPath, policy, ...scriptOptions };
  }

  if (entry.managed) {
    if (entry.content === script) {
      await chmod(hookPath, 0o755);
      return { action: "unchanged", hookPath, policy, ...scriptOptions };
    }
    await writeExecutable(hookPath, script);
    return { action: "updated", hookPath, policy, ...scriptOptions };
  }

  if (!force) {
    throw new Error(
      `A pre-commit hook that abb did not create already exists at ${formatTerminalValue(hookPath)}. ` +
        "Re-run with --force to back it up and replace it, or add the abb analyze command to it manually."
    );
  }

  const backupPath = `${hookPath}${HOOK_BACKUP_SUFFIX}`;
  if (await lstatOrUndefined(backupPath)) {
    throw new Error(
      `Cannot back up the existing hook: ${formatTerminalValue(backupPath)} already exists. Move it away and retry.`
    );
  }
  await copyFile(hookPath, backupPath, constants.COPYFILE_EXCL);
  await writeExecutable(hookPath, script);
  return { action: "installed", hookPath, policy, backupPath, ...scriptOptions };
}

/**
 * Removes the managed pre-commit hook and restores `pre-commit.pre-abb` when one exists.
 * A hook that abb did not write is never modified.
 */
export async function uninstallPreCommitHook(repoRoot: string): Promise<HookUninstallResult> {
  const hookPath = path.join(await resolveHooksDirectory(repoRoot), HOOK_FILE_NAME);
  if (!(await lstatOrUndefined(path.dirname(hookPath)))) return { action: "absent", hookPath };
  return withHookMutationLock(hookPath, () => uninstallHookAtPath(hookPath));
}

async function uninstallHookAtPath(hookPath: string): Promise<HookUninstallResult> {
  const entry = await inspectHookEntry(hookPath);

  if (entry.kind === "absent") {
    return { action: "absent", hookPath };
  }
  if (entry.kind === "unsafe" || !entry.managed) {
    return { action: "foreign", hookPath };
  }

  const backupPath = `${hookPath}${HOOK_BACKUP_SUFFIX}`;
  const backup = await lstatOrUndefined(backupPath);
  if (backup) {
    if (!backup.isFile()) {
      throw new Error(`Refusing to restore ${formatTerminalValue(backupPath)}: it is not a regular file.`);
    }
    // rename replaces the managed hook in one step, so there is no window without a hook.
    await rename(backupPath, hookPath);
    return { action: "removed", hookPath, restoredFrom: backupPath };
  }

  await rm(hookPath, { force: true });
  return { action: "removed", hookPath };
}

/** Git-style, cross-process exclusion: uncertain/stale locks require inspection rather than an unsafe takeover. */
async function withHookMutationLock<T>(hookPath: string, mutate: () => Promise<T>): Promise<T> {
  const directory = path.dirname(hookPath);
  await mkdir(directory, { recursive: true });
  if ((await realpath(directory)) !== directory) throw new Error("Hooks directory changed before hook mutation.");
  const lockPath = path.join(directory, ".pre-commit.abb-lock");
  const handle = await open(lockPath, "wx", 0o600).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException | undefined)?.code === "EEXIST") {
      throw new Error(
        `Another hook mutation is reserved at ${formatTerminalValue(lockPath)}. Inspect its owner before removing a stale lock and retrying.`,
        { cause: error }
      );
    }
    throw error;
  });
  const failures: unknown[] = [];
  let result: T | undefined;
  try {
    await handle.writeFile(`${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`);
    if ((await realpath(directory)) !== directory) throw new Error("Hooks directory changed during hook mutation.");
    result = await mutate();
  } catch (error) {
    failures.push(error);
  }
  try {
    const [owned, current, physicalDirectory] = await Promise.all([
      handle.stat({ bigint: true }),
      lstat(lockPath, { bigint: true }),
      realpath(directory),
    ]);
    if (
      physicalDirectory !== directory ||
      !current.isFile() ||
      owned.dev !== current.dev ||
      owned.ino !== current.ino
    ) {
      throw new Error(
        "The hook mutation lock changed; the replacement was left untouched. Inspect storage before retrying."
      );
    }
    await rm(lockPath);
  } catch (error) {
    failures.push(error);
  }
  try {
    await handle.close();
  } catch (error) {
    failures.push(error);
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, "Hook mutation and ownership cleanup failed.");
  return result as T;
}

/** Reports whether the pre-commit hook is absent, managed by abb (current or outdated), or foreign. */
export async function getPreCommitHookStatus(repoRoot: string): Promise<HookStatus> {
  const hookPath = path.join(await resolveHooksDirectory(repoRoot), HOOK_FILE_NAME);
  const entry = await inspectHookEntry(hookPath);

  if (entry.kind === "absent") {
    return { state: "absent", hookPath };
  }
  if (entry.kind === "unsafe" || !entry.managed) {
    return { state: "foreign", hookPath };
  }

  const policy = parseManagedPolicy(entry.content);
  const scriptOptions = parseManagedScriptOptions(entry.content);
  const current =
    policy !== undefined &&
    scriptOptions !== undefined &&
    entry.content === buildPreCommitHookScript(policy, scriptOptions) &&
    entry.executable;
  return policy === undefined
    ? { state: "managed-outdated", hookPath }
    : { state: current ? "managed" : "managed-outdated", hookPath, policy, ...scriptOptions };
}

/** Terminal-safe, multi-line description of an install outcome. */
export function renderHookInstallResult(result: HookInstallResult): string {
  const headline = {
    installed: "Installed pre-commit hook",
    updated: "Updated pre-commit hook",
    unchanged: "Pre-commit hook already up to date",
  }[result.action];
  const lines = [
    `${headline}: ${formatTerminalValue(result.hookPath)}`,
    `Policy: ${formatTerminalValue(result.policy)}`,
  ];
  if (result.allowExternalSessionDir) {
    lines.push("External session storage: explicitly allowed by this hook.");
  }
  if (result.firstCommit === "policy") {
    lines.push("First commit: selected policy.");
  }
  if (result.backupPath) {
    lines.push(`Previous hook saved to: ${formatTerminalValue(result.backupPath)}`);
  }
  return lines.join("\n");
}

/** Terminal-safe, multi-line description of an uninstall outcome. */
export function renderHookUninstallResult(result: HookUninstallResult): string {
  switch (result.action) {
    case "removed": {
      const lines = [`Removed pre-commit hook: ${formatTerminalValue(result.hookPath)}`];
      if (result.restoredFrom) {
        lines.push(`Restored previous hook from: ${formatTerminalValue(result.restoredFrom)}`);
      }
      return lines.join("\n");
    }
    case "absent":
      return `No pre-commit hook installed at ${formatTerminalValue(result.hookPath)}.`;
    case "foreign":
      return `The pre-commit hook at ${formatTerminalValue(result.hookPath)} was not installed by abb; left untouched.`;
  }
}

/** Terminal-safe, multi-line description of the hook status. */
export function renderHookStatus(status: HookStatus): string {
  const description = {
    absent: "not installed",
    managed: "installed (managed by abb)",
    "managed-outdated": "installed (managed by abb, content or permissions need updating; re-run `abb hook install`)",
    foreign: "present but not managed by abb",
  }[status.state];
  const lines = [`Pre-commit hook: ${description}`, `Path: ${formatTerminalValue(status.hookPath)}`];
  if (status.policy) {
    lines.push(`Policy: ${formatTerminalValue(status.policy)}`);
  }
  if (status.allowExternalSessionDir) {
    lines.push("External session storage: explicitly allowed by this hook.");
  }
  if (status.firstCommit === "policy") {
    lines.push("First commit: selected policy.");
  }
  return lines.join("\n");
}

type HookEntry =
  | { kind: "absent" }
  | { kind: "unsafe"; reason: string }
  | { kind: "file"; managed: false }
  | { kind: "file"; managed: true; content: string; executable: boolean };

function assertValidPolicy(policy: string): void {
  if (!POLICY_PATTERN.test(policy)) {
    throw new Error(
      `Invalid policy name ${formatTerminalValue(policy)}: use lowercase letters, digits and hyphens, starting with a letter (at most 64 characters).`
    );
  }
}

function parseManagedPolicy(content: string): string | undefined {
  const line = content.split(/\r?\n/)[2];
  if (line === undefined || !line.startsWith(POLICY_LINE_PREFIX)) {
    return undefined;
  }
  const policy = line.slice(POLICY_LINE_PREFIX.length);
  return POLICY_PATTERN.test(policy) ? policy : undefined;
}

function normalizeHookScriptOptions(options: HookScriptOptions): HookScriptOptions {
  if (options.allowExternalSessionDir !== undefined && typeof options.allowExternalSessionDir !== "boolean") {
    throw new Error("allowExternalSessionDir must be a boolean.");
  }
  if (options.firstCommit !== undefined && options.firstCommit !== "high" && options.firstCommit !== "policy") {
    throw new Error("firstCommit must be high or policy.");
  }
  return {
    ...(options.allowExternalSessionDir === true ? { allowExternalSessionDir: true } : {}),
    ...(options.firstCommit === "policy" ? { firstCommit: "policy" as const } : {}),
  };
}

function parseManagedScriptOptions(content: string): HookScriptOptions | undefined {
  const options: HookScriptOptions = {};
  for (const line of content.split(/\r?\n/).slice(3)) {
    if (line.startsWith("# agent-black-box allow-external-session-dir:")) {
      if (line !== EXTERNAL_STORAGE_LINE || options.allowExternalSessionDir !== undefined) {
        return undefined;
      }
      options.allowExternalSessionDir = true;
    } else if (line.startsWith("# agent-black-box first-commit:")) {
      if (line !== FIRST_COMMIT_POLICY_LINE || options.firstCommit !== undefined) {
        return undefined;
      }
      options.firstCommit = "policy";
    }
  }
  return options;
}

async function inspectHookEntry(hookPath: string): Promise<HookEntry> {
  const details = await lstatOrUndefined(hookPath);
  if (!details) {
    return { kind: "absent" };
  }
  if (details.isSymbolicLink()) {
    return { kind: "unsafe", reason: "it is a symbolic link" };
  }
  if (!details.isFile()) {
    return { kind: "unsafe", reason: "it is not a regular file" };
  }
  // A file larger than the cap cannot be a script this module generated.
  if (details.size > MAX_HOOK_BYTES) {
    return { kind: "file", managed: false };
  }

  const content = await readTextFileLimited(hookPath, MAX_HOOK_BYTES);
  return content.split(/\r?\n/)[1] === HOOK_MARKER
    ? {
        kind: "file",
        managed: true,
        content,
        executable: await isHookExecutable(hookPath),
      }
    : { kind: "file", managed: false };
}

async function isHookExecutable(hookPath: string): Promise<boolean> {
  if (process.platform === "win32") {
    return true;
  }
  try {
    await access(hookPath, constants.X_OK);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === "EACCES") {
      return false;
    }
    throw error;
  }
}

async function writeExecutable(hookPath: string, script: string, overwrite = true): Promise<void> {
  await writeTextFileAtomic(hookPath, script, { overwrite });
  // The atomic writer creates 0600 files; Git only runs hooks that are executable. No-op on Windows.
  await chmod(hookPath, 0o755);
}

async function lstatOrUndefined(target: string): Promise<Awaited<ReturnType<typeof lstat>> | undefined> {
  try {
    return await lstat(target);
  } catch (error) {
    if (isMissingPathError(error)) {
      return undefined;
    }
    throw error;
  }
}

/**
 * Resolves the effective hooks directory (honouring `core.hooksPath` and linked worktrees) and
 * returns its physical path, refusing locations outside this repository. A shared global
 * `core.hooksPath` would otherwise let one repository modify the hooks of every other one.
 */
async function resolveHooksDirectory(repoRoot: string): Promise<string> {
  const rootGit = createGit(repoRoot);
  const topLevel = path.resolve(repoRoot, await gitPathOutput(rootGit.raw(["rev-parse", "--show-toplevel"])));
  const git = createGit(topLevel);
  const [hooksOutput, commonOutput] = await Promise.all([
    gitPathOutput(git.raw(["rev-parse", "--git-path", "hooks"])),
    gitPathOutput(git.raw(["rev-parse", "--git-common-dir"])),
  ]);

  const hooksDirectory = await realpathLenient(path.resolve(topLevel, hooksOutput));
  const allowedRoots = await Promise.all([
    realpathLenient(topLevel),
    realpathLenient(path.resolve(topLevel, commonOutput)),
  ]);
  if (!allowedRoots.some((root) => isPathInside(root, hooksDirectory))) {
    throw new Error(
      `Refusing to use hooks directory ${formatTerminalValue(hooksDirectory)}: it is outside this repository. ` +
        "A shared core.hooksPath would affect other repositories; set a repository-local hooks path instead."
    );
  }
  return hooksDirectory;
}

async function gitPathOutput(pending: Promise<string>): Promise<string> {
  const output = (await pending).replace(/\r?\n$/, "");
  if (!output) {
    throw new Error("Git returned an empty path; is this a non-bare Git work tree?");
  }
  return output;
}

/** Physical path of the deepest existing ancestor, with the not-yet-created remainder appended. */
async function realpathLenient(target: string): Promise<string> {
  const missing: string[] = [];
  let current = path.resolve(target);
  while (true) {
    try {
      return path.join(await realpath(current), ...missing.reverse());
    } catch (error) {
      const parent = path.dirname(current);
      if (!isMissingPathError(error) || parent === current) {
        throw error;
      }
      missing.push(path.basename(current));
      current = parent;
    }
  }
}

function isMissingPathError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}
