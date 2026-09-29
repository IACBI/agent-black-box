import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { createHash } from "node:crypto";
import { lstat, open, readlink, realpath } from "node:fs/promises";
import path from "node:path";
import { simpleGit } from "simple-git";
import type { AgentBlackBoxConfig, ChangedFile, FileChangeEvidence, SessionReport } from "../types.js";
import { collectGitSnapshot } from "../git/git.js";
import { indexFileChangeEvidence } from "../session/changeEvidence.js";
import { mapWithConcurrency } from "../utils/concurrency.js";
import { readJsonFileLimited, writeJsonFile } from "../utils/files.js";
import { resolveRepoPath, shellQuotePath } from "../utils/paths.js";

export interface RollbackPlan {
  requestedFiles: string[];
  restorableFiles: ChangedFile[];
  skippedFiles: Array<{ path: string; reason: string }>;
}

const RESTORABLE_STATUSES = new Set(["modified", "deleted"]);
const ROLLBACK_STATE_FILE = "rollback-state.json";
const MAX_ROLLBACK_STATE_BYTES = 32 * 1024 * 1024;

interface RollbackFileState {
  path: string;
  status: ChangedFile["status"];
  kind: "file" | "symlink" | "missing" | "unavailable";
  digest?: string;
  mode?: number;
  parent?: string;
}

interface RollbackSafetyState {
  version: 1;
  sessionId: string;
  head: string | null;
  indexFingerprint: string | null;
  files: RollbackFileState[];
}

export function createRollbackPlan(report: SessionReport, requestedFiles: string[] = []): RollbackPlan {
  const requested = new Set(requestedFiles);
  const candidateFiles =
    requestedFiles.length > 0
      ? report.git.changedFiles.filter((file) => requested.has(file.path))
      : report.git.changedFiles;
  const evidenceByPath = indexFileChangeEvidence(report.changeEvidence);
  const missingFiles = requestedFiles.filter(
    (file) => !report.git.changedFiles.some((changed) => changed.path === file)
  );
  const restorableFiles = candidateFiles.filter((file) => isSafelyRestorable(file, evidenceByPath.get(file.path)));
  const skippedFiles = [
    ...candidateFiles
      .filter((file) => !isSafelyRestorable(file, evidenceByPath.get(file.path)))
      .map((file) => ({
        path: file.path,
        reason: getSkipReason(file, evidenceByPath.get(file.path)),
      })),
    ...missingFiles.map((file) => ({
      path: file,
      reason: "File was not present in the latest Agent Black Box session report.",
    })),
  ];

  return {
    requestedFiles,
    restorableFiles,
    skippedFiles,
  };
}

export async function writeRollbackSafetyState(report: SessionReport): Promise<void> {
  const plan = createRollbackPlan(report);
  const files = await mapWithConcurrency(plan.restorableFiles, 4, async (file) => {
    try {
      return { ...(await inspectRollbackFile(report.repoRoot, file.path)), status: file.status };
    } catch {
      return { path: file.path, status: file.status, kind: "unavailable" as const };
    }
  });
  const state: RollbackSafetyState = {
    version: 1,
    sessionId: report.id,
    head: report.git.head ?? null,
    indexFingerprint: report.git.indexFingerprint ?? null,
    files,
  };
  await writeJsonFile(path.join(report.sessionDir, ROLLBACK_STATE_FILE), state);
}

export async function verifyRollbackSafetyState(
  repoRoot: string,
  sessionDir: string,
  report: SessionReport,
  plan: RollbackPlan,
  config: AgentBlackBoxConfig
): Promise<void> {
  let value: unknown;
  try {
    value = await readJsonFileLimited<unknown>(path.join(sessionDir, ROLLBACK_STATE_FILE), MAX_ROLLBACK_STATE_BYTES);
  } catch {
    throw new Error("This session has no readable rollback safety snapshot; automatic restore was refused.");
  }
  if (!isRollbackSafetyState(value) || value.sessionId !== report.id) {
    throw new Error("Rollback safety snapshot is invalid or belongs to another session.");
  }
  if (value.head !== (report.git.head ?? null) || value.indexFingerprint !== (report.git.indexFingerprint ?? null)) {
    throw new Error("Rollback safety snapshot does not match the selected session report.");
  }

  const current = await collectGitSnapshot(repoRoot, config.exclude);
  if ((current.head ?? null) !== value.head || (current.indexFingerprint ?? null) !== value.indexFingerprint) {
    throw new Error(
      "Repository HEAD or staged changes differ from the session end state; automatic restore was refused."
    );
  }

  const recorded = new Map(value.files.map((file) => [file.path, file]));
  for (const file of plan.restorableFiles) {
    const expected = recorded.get(file.path);
    const currentStatus = current.changedFiles.find((changed) => changed.path === file.path)?.status;
    if (!expected || expected.status !== file.status || currentStatus !== file.status) {
      throw new Error(`The recorded change for ${file.path} is no longer current; automatic restore was refused.`);
    }
    if (expected.kind === "unavailable") {
      throw new Error(`The session could not verify ${file.path} when it ended; automatic restore was refused.`);
    }
    const actual = await inspectRollbackFile(repoRoot, file.path);
    if (
      actual.kind !== expected.kind ||
      actual.digest !== expected.digest ||
      actual.mode !== expected.mode ||
      actual.parent !== expected.parent
    ) {
      throw new Error(
        `The contents or location of ${file.path} changed since the session; automatic restore was refused.`
      );
    }
  }
}

export async function applyVerifiedRollbackPlan(
  repoRoot: string,
  sessionDir: string,
  report: SessionReport,
  plan: RollbackPlan,
  config: AgentBlackBoxConfig
): Promise<void> {
  await verifyRollbackSafetyState(repoRoot, sessionDir, report, plan, config);
  await applyRollbackPlan(repoRoot, plan);
}

async function inspectRollbackFile(repoRoot: string, filePath: string): Promise<Omit<RollbackFileState, "status">> {
  const absolutePath = resolveRepoPath(repoRoot, filePath);
  if (!absolutePath) {
    throw new Error("Rollback path must stay inside the repository.");
  }
  const physicalRoot = await realpath(repoRoot);
  const physicalParent = await realpath(path.dirname(absolutePath)).catch((error: unknown) => {
    if (isNotFound(error)) {
      return null;
    }
    throw error;
  });
  if (physicalParent) {
    const relativeParent = path.relative(physicalRoot, physicalParent);
    if (relativeParent === ".." || relativeParent.startsWith(`..${path.sep}`) || path.isAbsolute(relativeParent)) {
      throw new Error(`Rollback path ${filePath} resolves outside the repository.`);
    }
  }

  let details;
  try {
    details = await lstat(absolutePath);
  } catch (error) {
    if (isNotFound(error)) {
      return { path: filePath, kind: "missing", ...(physicalParent ? { parent: physicalParent } : {}) };
    }
    throw error;
  }

  if (details.isSymbolicLink()) {
    const target = await readlink(absolutePath);
    return {
      path: filePath,
      kind: "symlink",
      digest: createHash("sha256").update(target).digest("hex"),
      mode: details.mode & 0o7777,
      ...(physicalParent ? { parent: physicalParent } : {}),
    };
  }
  if (!details.isFile()) {
    throw new Error(`Rollback path ${filePath} is not a regular file or symbolic link.`);
  }

  const handle = await open(absolutePath, "r");
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== details.dev || opened.ino !== details.ino) {
      throw new Error(`Rollback path ${filePath} changed during inspection.`);
    }
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) {
        break;
      }
      hash.update(buffer.subarray(0, bytesRead));
    }
    const completed = await handle.stat();
    if (completed.size !== opened.size || completed.mtimeMs !== opened.mtimeMs) {
      throw new Error(`Rollback path ${filePath} changed during inspection.`);
    }
    return {
      path: filePath,
      kind: "file",
      digest: hash.digest("hex"),
      mode: details.mode & 0o7777,
      ...(physicalParent ? { parent: physicalParent } : {}),
    };
  } finally {
    await handle.close();
  }
}

function isRollbackSafetyState(value: unknown): value is RollbackSafetyState {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const state = value as Record<string, unknown>;
  return (
    state.version === 1 &&
    typeof state.sessionId === "string" &&
    (state.head === null || typeof state.head === "string") &&
    (state.indexFingerprint === null || typeof state.indexFingerprint === "string") &&
    Array.isArray(state.files) &&
    state.files.every(
      (file: unknown) =>
        typeof file === "object" &&
        file !== null &&
        !Array.isArray(file) &&
        typeof (file as RollbackFileState).path === "string" &&
        ["modified", "deleted"].includes((file as RollbackFileState).status) &&
        ["file", "symlink", "missing", "unavailable"].includes((file as RollbackFileState).kind) &&
        ((file as RollbackFileState).digest === undefined ||
          /^[0-9a-f]{64}$/.test((file as RollbackFileState).digest ?? "")) &&
        ((file as RollbackFileState).mode === undefined || Number.isInteger((file as RollbackFileState).mode)) &&
        ((file as RollbackFileState).parent === undefined || typeof (file as RollbackFileState).parent === "string")
    )
  );
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function isSafelyRestorable(file: ChangedFile, evidence: FileChangeEvidence | undefined): boolean {
  if (!RESTORABLE_STATUSES.has(file.status)) {
    return false;
  }

  return evidence?.atStart === false;
}

function getSkipReason(file: ChangedFile, evidence: FileChangeEvidence | undefined): string {
  if (file.status === "added") {
    return "Added or untracked files are not removed automatically.";
  }

  if (!RESTORABLE_STATUSES.has(file.status)) {
    return `Status ${file.status} is not automatically restored.`;
  }

  if (evidence?.atStart === true) {
    return "File already had changes at session start; restoring to HEAD could discard pre-session work.";
  }

  return "No reliable session-start baseline is available for this file.";
}

export function renderRollbackPlan(plan: RollbackPlan): string {
  const lines = ["Agent Black Box Rollback Apply Plan", ""];

  if (plan.restorableFiles.length > 0) {
    lines.push("Files that can be restored after confirmation:");
    for (const file of plan.restorableFiles) {
      lines.push(`- ${file.status}: ${file.path}`);
    }
    lines.push("");
    lines.push("Command preview:");
    lines.push("```sh");
    lines.push(
      `git restore --source=HEAD --staged --worktree -- ${plan.restorableFiles.map((file) => shellQuotePath(toLiteralGitPathspec(file.path))).join(" ")}`
    );
    lines.push("```");
  } else {
    lines.push("No files are eligible for automatic restore.");
  }

  if (plan.skippedFiles.length > 0) {
    lines.push("");
    lines.push("Skipped files:");
    for (const file of plan.skippedFiles) {
      lines.push(`- ${file.path}: ${file.reason}`);
    }
  }

  return `${lines.join("\n")}\n`;
}

export async function confirmRollback(plan: RollbackPlan): Promise<boolean> {
  if (!input.isTTY || !output.isTTY) {
    throw new Error("Interactive rollback requires a TTY. Re-run the command in an interactive terminal.");
  }

  const confirmationText = getConfirmationText(plan);
  const rl = createInterface({ input, output });
  try {
    const answer = await rl.question(`Type "${confirmationText}" to restore eligible files: `);
    return answer === confirmationText;
  } finally {
    rl.close();
  }
}

export async function applyRollbackPlan(repoRoot: string, plan: RollbackPlan): Promise<void> {
  if (plan.restorableFiles.length === 0) {
    return;
  }

  const git = simpleGit({ baseDir: repoRoot, binary: "git" });
  await git.raw([
    "restore",
    "--source=HEAD",
    "--staged",
    "--worktree",
    "--",
    ...plan.restorableFiles.map((file) => toLiteralGitPathspec(file.path)),
  ]);
}

export function toLiteralGitPathspec(filePath: string): string {
  return `:(top,literal)${filePath.replace(/\\/g, "/")}`;
}

export function getConfirmationText(plan: RollbackPlan): string {
  const fileLabel = plan.restorableFiles.length === 1 ? "file" : "files";
  return `RESTORE ${plan.restorableFiles.length} ${fileLabel}`;
}
