import { execFile } from "node:child_process";
import type { SimpleGit } from "simple-git";
import { createGit, gitExecutable } from "../git/executable.js";
import type { AgentBlackBoxConfig } from "../types.js";
import { collectStagedChanges } from "../git/git.js";
import { mapWithConcurrency } from "../utils/concurrency.js";
import { isLikelyBinary } from "../utils/fileInspection.js";
import { isPathExcluded, normalizePath } from "../utils/paths.js";
import type { AnalysisInputFile } from "./analyzer.js";

const MAX_ANALYSIS_BYTES = 256 * 1024;

export async function collectStagedAnalysisInputFiles(
  repoRoot: string,
  config: AgentBlackBoxConfig
): Promise<AnalysisInputFile[]> {
  const changedFiles = await collectStagedChanges(repoRoot, config.exclude);
  if (changedFiles.length === 0) {
    return [];
  }

  const git = createGit(repoRoot);
  const indexEntries = new Map<string, { mode: string; objectId: string }>();
  const indexOutput = await git.raw(["ls-files", "--stage", "-z"]);
  for (const entry of indexOutput.split("\0")) {
    const match = /^([0-7]{6}) ([0-9a-f]{40,64}) 0\t([\s\S]+)$/.exec(entry);
    if (match) {
      indexEntries.set(normalizePath(match[3]), { mode: match[1], objectId: match[2] });
    }
  }

  const maxBytes = Math.min(config.maxFileSizeKb * 1024, MAX_ANALYSIS_BYTES);
  return mapWithConcurrency(changedFiles, 4, async (file) => {
    if (file.status === "deleted") {
      return file;
    }
    const indexEntry = indexEntries.get(file.path);
    if (!indexEntry) {
      return { ...file, kind: "missing" as const, analysisSkipReason: "No complete staged blob exists for this path." };
    }
    if (indexEntry.mode !== "100644" && indexEntry.mode !== "100755") {
      return { ...file, kind: "not-file" as const, analysisSkipReason: "The staged entry is not a regular file." };
    }

    const blob = await readGitBlob(repoRoot, indexEntry.objectId, maxBytes);
    if (blob === null) {
      return { ...file, kind: "large" as const, analysisSkipReason: `The staged blob exceeds ${maxBytes} bytes.` };
    }
    if (isLikelyBinary(blob)) {
      return {
        ...file,
        kind: "binary" as const,
        sizeBytes: blob.length,
        analysisSkipReason: "Binary-like staged content.",
      };
    }
    return { ...file, kind: "text" as const, sizeBytes: blob.length, content: blob.toString("utf8") };
  });
}

export async function resolveBaselineCommit(repoRoot: string, reference: string): Promise<string> {
  if (!reference || reference.length > 200 || /[\r\n\0]/.test(reference)) {
    throw new Error("--baseline must identify an existing Git commit.");
  }
  try {
    const git = createGit(repoRoot);
    const commit = (await git.raw(["rev-parse", "--verify", "--end-of-options", `${reference}^{commit}`])).trim();
    if (/^[0-9a-f]{40,64}$/.test(commit)) {
      return commit;
    }
  } catch {
    // Invalid revisions are reported without echoing untrusted input.
  }
  throw new Error("--baseline must identify an existing Git commit.");
}

export async function collectBaselineAnalysisInputFiles(
  repoRoot: string,
  stagedFiles: readonly AnalysisInputFile[],
  config: AgentBlackBoxConfig,
  commit: string
): Promise<AnalysisInputFile[]> {
  if (!/^[0-9a-f]{40,64}$/.test(commit)) {
    throw new Error("Baseline commit must be a full Git object ID.");
  }
  const git = createGit(repoRoot);
  const maxBytes = Math.min(config.maxFileSizeKb * 1024, MAX_ANALYSIS_BYTES);
  const samePathEntries = await mapWithConcurrency(stagedFiles, 4, (file) =>
    file.status === "deleted" ? Promise.resolve(null) : findBaselineBlob(git, commit, file.path)
  );
  const needsRenameLookup = stagedFiles.some((file, index) => file.status !== "deleted" && !samePathEntries[index]);
  const renameSources = needsRenameLookup
    ? await collectBaselineRenameSources(git, commit, config.exclude)
    : new Map<string, string>();
  return mapWithConcurrency(stagedFiles, 4, async (file, index) => {
    if (file.status === "deleted") {
      return { ...file, analysisSkipReason: "Deleted staged paths have no content finding to compare." };
    }
    let entry = samePathEntries[index];
    let baselineSourcePath: string | undefined;
    if (!entry) {
      const sourcePath = renameSources.get(file.path);
      if (sourcePath) {
        entry = await findBaselineBlob(git, commit, sourcePath);
        if (entry) {
          baselineSourcePath = sourcePath;
        }
      }
    }
    if (!entry) {
      return { path: file.path, status: file.status, kind: "missing" as const };
    }
    if (entry.mode !== "100644" && entry.mode !== "100755") {
      return {
        path: file.path,
        status: file.status,
        kind: "not-file" as const,
        analysisSkipReason: "The baseline entry is not a regular file.",
      };
    }
    const blob = await readGitBlob(repoRoot, entry.objectId, maxBytes);
    if (blob === null) {
      return {
        path: file.path,
        status: file.status,
        kind: "large" as const,
        analysisSkipReason: `The baseline blob exceeds ${maxBytes} bytes.`,
      };
    }
    if (isLikelyBinary(blob)) {
      return {
        path: file.path,
        status: file.status,
        kind: "binary" as const,
        analysisSkipReason: "Binary-like baseline content.",
      };
    }
    return {
      path: file.path,
      status: file.status,
      kind: "text" as const,
      content: blob.toString("utf8"),
      ...(baselineSourcePath ? { baselineSourcePath } : {}),
    };
  });
}

async function collectBaselineRenameSources(
  git: SimpleGit,
  commit: string,
  excludePatterns: string[]
): Promise<Map<string, string>> {
  const output = await git.raw([
    "diff",
    "--cached",
    "--name-status",
    "-z",
    "--no-ext-diff",
    "--no-textconv",
    "--find-renames",
    commit,
    "--",
  ]);
  const tokens = output.split("\0");
  const sources = new Map<string, string>();
  for (let index = 0; index < tokens.length - 1;) {
    const status = tokens[index++];
    if (/^[RC]\d+$/.test(status)) {
      const source = normalizePath(tokens[index++] ?? "");
      const destination = normalizePath(tokens[index++] ?? "");
      if (status.startsWith("R") && source && destination && !isPathExcluded(source, excludePatterns)) {
        sources.set(destination, source);
      }
    } else {
      index += 1;
    }
  }
  return sources;
}

async function findBaselineBlob(
  git: SimpleGit,
  commit: string,
  filePath: string
): Promise<{ mode: string; objectId: string } | null> {
  const tree = await git.raw(["ls-tree", "-r", "-z", commit, "--", `:(top,literal)${filePath}`]);
  for (const item of tree.split("\0")) {
    const match = /^([0-7]{6}) blob ([0-9a-f]{40,64})\t([\s\S]+)$/.exec(item);
    if (match && normalizePath(match[3]) === filePath) {
      return { mode: match[1], objectId: match[2] };
    }
  }
  return null;
}

function readGitBlob(repoRoot: string, objectId: string, maxBytes: number): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    execFile(
      gitExecutable(),
      ["cat-file", "blob", objectId],
      { cwd: repoRoot, encoding: "buffer", maxBuffer: maxBytes + 1 },
      (error, stdout) => {
        if (error) {
          if ("code" in error && error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
            resolve(null);
            return;
          }
          reject(new Error("Could not read a staged Git blob.", { cause: error }));
          return;
        }
        if (!Buffer.isBuffer(stdout)) {
          reject(new Error("Git returned an unexpected staged blob format."));
          return;
        }
        resolve(stdout.length > maxBytes ? null : stdout);
      }
    );
  });
}
