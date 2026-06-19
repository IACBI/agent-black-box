import path from "node:path";
import { createHash } from "node:crypto";
import { simpleGit } from "simple-git";
import type { ChangedFile, ChangeStatus, GitSnapshot } from "../types.js";
import { inspectTextFile, type FileInspection } from "../utils/fileInspection.js";
import { isPathExcluded, normalizePath } from "../utils/paths.js";

const MAX_ESTIMATED_UNTRACKED_FILE_BYTES = 500 * 1024;

export async function getRepositoryRoot(cwd: string): Promise<string | null> {
  try {
    const git = simpleGit({ baseDir: cwd, binary: "git" });
    const root = await git.revparse(["--show-toplevel"]);
    return root.trim();
  } catch (error) {
    const message = getGitErrorMessage(error);
    if (message.includes("not a git repository") || message.includes("not a gitdir")) {
      return null;
    }

    throw new Error(`Git repository detection failed: ${message}`);
  }
}

function getGitErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }

  return String(error);
}

export async function tryGetRepositoryRoot(cwd: string): Promise<string | null> {
  try {
    return await getRepositoryRoot(cwd);
  } catch {
    return null;
  }
}

export async function requireRepositoryRoot(cwd: string): Promise<string> {
  const root = await getRepositoryRoot(cwd);
  if (!root) {
    throw new Error("Agent Black Box must be run inside a Git repository.");
  }

  return root;
}

export async function isGitRepository(cwd: string): Promise<boolean> {
  return (await tryGetRepositoryRoot(cwd)) !== null;
}

export async function collectGitSnapshot(repoRoot: string, excludePatterns: string[] = []): Promise<GitSnapshot> {
  const git = simpleGit({ baseDir: repoRoot, binary: "git" });
  const diffPathspecs = buildDiffPathspecs(excludePatterns);
  const [status, head, indexFingerprint, diffSummary, unstagedStat, stagedStat] = await Promise.all([
    git.status(),
    getHeadRevision(git),
    getIndexFingerprint(git, diffPathspecs),
    git.diffSummary(),
    git.raw(diffPathspecs.length > 0 ? ["diff", "--stat", "--", ...diffPathspecs] : ["diff", "--stat"]),
    git.raw(diffPathspecs.length > 0 ? ["diff", "--cached", "--stat", "--", ...diffPathspecs] : ["diff", "--cached", "--stat"])
  ]);

  const summaryByPath = new Map(
    diffSummary.files.map((file) => [
      normalizePath(file.file),
      {
        insertions: "insertions" in file ? file.insertions : undefined,
        deletions: "deletions" in file ? file.deletions : undefined
      }
    ])
  );

  const visibleStatusFiles = status.files.filter((file) => !isPathExcluded(file.path, excludePatterns));
  const changedFiles = await Promise.all(visibleStatusFiles.map(async (file) => {
    const normalizedPath = normalizePath(file.path);
    const summary = summaryByPath.get(normalizedPath);
    const status = mapStatus(file.index, file.working_dir);
    const inspectionResult =
      status === "added" || status === "modified"
        ? await inspectTextFile(path.join(repoRoot, normalizedPath), MAX_ESTIMATED_UNTRACKED_FILE_BYTES)
        : undefined;
    const estimated =
      summary?.insertions === undefined && status === "added"
        ? estimateAddedTextFileStats(inspectionResult)
        : undefined;
    const lineStatsSource = summary?.insertions !== undefined || summary?.deletions !== undefined
      ? "git"
      : estimated?.lineStatsSource;

    return {
      path: normalizedPath,
      status,
      insertions: summary?.insertions ?? estimated?.insertions,
      deletions: summary?.deletions ?? estimated?.deletions,
      ...(inspectionResult ? inspectionToChangedFileMetadata(inspectionResult) : {}),
      ...(lineStatsSource ? { lineStatsSource } : {}),
      ...(estimated?.statsNote ? { statsNote: estimated.statsNote } : {})
    };
  }));

  return {
    repoRoot,
    ...(head ? { head } : {}),
    indexFingerprint,
    branch: status.current || undefined,
    statusText: changedFiles.length === 0 ? "Working tree clean for included paths." : formatStatusFiles(changedFiles),
    diffSummaryText: formatDiffSummary(unstagedStat, stagedStat, changedFiles),
    changedFiles
  };
}

export async function collectGitChangesBetween(
  repoRoot: string,
  fromHead: string | undefined,
  toHead: string | undefined,
  excludePatterns: string[] = []
): Promise<ChangedFile[]> {
  if (!toHead || fromHead === toHead) {
    return [];
  }

  if (!isGitObjectId(toHead) || (fromHead && !isGitObjectId(fromHead))) {
    throw new Error("Git revision comparison requires full hexadecimal object IDs.");
  }

  const git = simpleGit({ baseDir: repoRoot, binary: "git" });
  if (!fromHead) {
    const output = await git.raw(["ls-tree", "-r", "--name-only", "-z", toHead]);
    return output
      .split("\0")
      .filter(Boolean)
      .map((filePath) => ({ path: normalizePath(filePath), status: "added" as const }))
      .filter((file) => !isPathExcluded(file.path, excludePatterns));
  }

  const pathspecs = buildDiffPathspecs(excludePatterns);
  const output = await git.raw([
    "diff",
    "--name-status",
    "-z",
    "--find-renames",
    fromHead,
    toHead,
    ...(pathspecs.length > 0 ? ["--", ...pathspecs] : [])
  ]);

  return parseNameStatus(output).filter((file) => !isPathExcluded(file.path, excludePatterns));
}

function isGitObjectId(value: string): boolean {
  return /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(value);
}

async function getIndexFingerprint(
  git: ReturnType<typeof simpleGit>,
  pathspecs: string[]
): Promise<string> {
  const args = pathspecs.length > 0
    ? ["diff", "--cached", "--raw", "-z", "--", ...pathspecs]
    : ["diff", "--cached", "--raw", "-z"];
  const stagedState = await git.raw(args);
  return createHash("sha256").update(stagedState).digest("hex");
}

async function getHeadRevision(git: ReturnType<typeof simpleGit>): Promise<string | undefined> {
  try {
    return (await git.revparse(["--verify", "HEAD"])).trim() || undefined;
  } catch {
    return undefined;
  }
}

function buildDiffPathspecs(excludePatterns: string[]): string[] {
  const normalized = [...new Set(excludePatterns.map((pattern) => normalizePath(pattern)).filter(Boolean))];
  if (normalized.length === 0) {
    return [];
  }

  return [
    ":(top,glob)**",
    ...normalized.flatMap((pattern) => [
      `:(top,exclude)${pattern}`,
      `:(top,glob,exclude)**/${pattern}`,
      `:(top,glob,exclude)**/${pattern}/**`
    ])
  ];
}

function parseNameStatus(output: string): ChangedFile[] {
  const tokens = output.split("\0");
  const files: ChangedFile[] = [];

  for (let index = 0; index < tokens.length;) {
    const statusToken = tokens[index++];
    if (!statusToken) {
      continue;
    }

    if (statusToken.startsWith("R") || statusToken.startsWith("C")) {
      index += 1;
      const destination = tokens[index++];
      if (destination) {
        files.push({ path: normalizePath(destination), status: "renamed" });
      }
      continue;
    }

    const filePath = tokens[index++];
    if (filePath) {
      files.push({ path: normalizePath(filePath), status: mapDiffStatus(statusToken) });
    }
  }

  return files;
}

function mapDiffStatus(status: string): ChangeStatus {
  if (status.startsWith("A")) {
    return "added";
  }
  if (status.startsWith("D")) {
    return "deleted";
  }
  if (status.startsWith("R") || status.startsWith("C")) {
    return "renamed";
  }
  if (status.startsWith("M") || status.startsWith("T")) {
    return "modified";
  }
  return "unknown";
}

function mapStatus(indexStatus: string, workingTreeStatus: string): ChangeStatus {
  const combined = `${indexStatus}${workingTreeStatus}`;

  if (combined.includes("R")) {
    return "renamed";
  }

  if (combined.includes("D")) {
    return "deleted";
  }

  if (combined.includes("A") || combined.includes("?")) {
    return "added";
  }

  if (combined.includes("M")) {
    return "modified";
  }

  return "unknown";
}

function formatStatusFiles(files: ChangedFile[]): string {
  return files.map((file) => `${file.status.padEnd(8)} ${file.path}`).join("\n");
}

function inspectionToChangedFileMetadata(inspection: FileInspection): Pick<ChangedFile, "kind" | "sizeBytes"> {
  return {
    kind: inspection.kind,
    ...(inspection.sizeBytes !== undefined ? { sizeBytes: inspection.sizeBytes } : {})
  };
}

function estimateAddedTextFileStats(
  inspection: FileInspection | undefined
): Pick<ChangedFile, "insertions" | "deletions" | "lineStatsSource" | "statsNote"> | undefined {
  if (!inspection) {
    return undefined;
  }

  if (inspection.kind !== "text" || inspection.text === undefined) {
    return {
      deletions: 0,
      lineStatsSource: "skipped",
      statsNote: inspection.reason ?? `Skipped line estimation for ${inspection.kind} file.`
    };
  }

  return {
    insertions: countLines(inspection.text),
    deletions: 0,
    lineStatsSource: "estimated",
    statsNote: "Estimated from untracked text file contents."
  };
}

function countLines(content: string): number {
  if (content.length === 0) {
    return 0;
  }

  const normalized = content.replace(/\r\n/g, "\n");
  const trailingNewlineAdjustment = normalized.endsWith("\n") ? 1 : 0;
  return normalized.split("\n").length - trailingNewlineAdjustment;
}

function formatDiffSummary(unstagedStat: string, stagedStat: string, changedFiles: ChangedFile[]): string {
  const sections = [];

  if (unstagedStat.trim()) {
    sections.push(`Unstaged diff:\n${unstagedStat.trimEnd()}`);
  }

  if (stagedStat.trim()) {
    sections.push(`Staged diff:\n${stagedStat.trimEnd()}`);
  }

  if (sections.length > 0) {
    return sections.join("\n\n");
  }

  if (changedFiles.some((file) => file.status === "added" && file.lineStatsSource === "estimated")) {
    return "No tracked Git diff was detected. Added-line counts for untracked text files were estimated from file contents.";
  }

  if (changedFiles.some((file) => file.status === "added" && file.lineStatsSource === "skipped")) {
    return "No tracked Git diff was detected. Some untracked files were binary, large, missing, or not regular files, so line counts were skipped.";
  }

  return "No tracked Git diff was detected.";
}
