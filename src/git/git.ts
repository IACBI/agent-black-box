import { simpleGit } from "simple-git";
import type { ChangedFile, ChangeStatus, GitSnapshot } from "../types.js";
import { normalizePath } from "../utils/paths.js";

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

export async function collectGitSnapshot(repoRoot: string): Promise<GitSnapshot> {
  const git = simpleGit({ baseDir: repoRoot, binary: "git" });
  const [status, diffSummary, unstagedStat, stagedStat] = await Promise.all([
    git.status(),
    git.diffSummary(),
    git.raw(["diff", "--stat"]),
    git.raw(["diff", "--cached", "--stat"])
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

  const changedFiles = status.files.map((file) => {
    const normalizedPath = normalizePath(file.path);
    const summary = summaryByPath.get(normalizedPath);
    return {
      path: normalizedPath,
      status: mapStatus(file.index, file.working_dir),
      insertions: summary?.insertions,
      deletions: summary?.deletions
    };
  });

  return {
    repoRoot,
    branch: status.current || undefined,
    statusText: status.files.length === 0 ? "Working tree clean." : formatStatusFiles(changedFiles),
    diffSummaryText: formatDiffSummary(unstagedStat, stagedStat),
    changedFiles
  };
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

function formatDiffSummary(unstagedStat: string, stagedStat: string): string {
  const sections = [];

  if (unstagedStat.trim()) {
    sections.push(`Unstaged diff:\n${unstagedStat.trimEnd()}`);
  }

  if (stagedStat.trim()) {
    sections.push(`Staged diff:\n${stagedStat.trimEnd()}`);
  }

  return sections.length > 0 ? sections.join("\n\n") : "No tracked Git diff was detected.";
}
