import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { simpleGit } from "simple-git";
import type { ChangedFile, ChangeStatus, GitSnapshot } from "../types.js";
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
  const [status, diffSummary, unstagedStat, stagedStat] = await Promise.all([
    git.status(),
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
    const estimatedInsertions =
      summary?.insertions === undefined && status === "added"
        ? await estimateAddedTextFileInsertions(repoRoot, normalizedPath)
        : undefined;

    return {
      path: normalizedPath,
      status,
      insertions: summary?.insertions ?? estimatedInsertions,
      deletions: summary?.deletions
    };
  }));

  return {
    repoRoot,
    branch: status.current || undefined,
    statusText: status.files.length === 0 ? "Working tree clean." : formatStatusFiles(changedFiles),
    diffSummaryText: formatDiffSummary(unstagedStat, stagedStat, changedFiles),
    changedFiles
  };
}

function buildDiffPathspecs(excludePatterns: string[]): string[] {
  const normalized = [...new Set(excludePatterns.map((pattern) => normalizePath(pattern)).filter(Boolean))];
  if (normalized.length === 0) {
    return [];
  }

  return [":(top).", ...normalized.map((pattern) => `:(top,exclude)${pattern}`)];
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

async function estimateAddedTextFileInsertions(repoRoot: string, relativePath: string): Promise<number | undefined> {
  const absolutePath = path.join(repoRoot, relativePath);

  try {
    const stats = await stat(absolutePath);
    if (!stats.isFile() || stats.size > MAX_ESTIMATED_UNTRACKED_FILE_BYTES) {
      return undefined;
    }

    const content = await readFile(absolutePath, "utf8");
    if (content.includes("\u0000")) {
      return undefined;
    }

    return countLines(content);
  } catch {
    return undefined;
  }
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

  if (changedFiles.some((file) => file.status === "added" && file.insertions !== undefined)) {
    return "No tracked Git diff was detected. Added-line counts for untracked text files were estimated from file contents.";
  }

  return "No tracked Git diff was detected.";
}
