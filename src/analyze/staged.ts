import type { SimpleGit } from "simple-git";
import { readGitBlobs } from "../git/blobReader.js";
import { createGit } from "../git/executable.js";
import type { AgentBlackBoxConfig } from "../types.js";
import { collectStagedChanges } from "../git/git.js";
import { mapWithConcurrency } from "../utils/concurrency.js";
import { isLikelyBinary } from "../utils/fileInspection.js";
import { isPathExcluded, normalizeRepoPath } from "../utils/paths.js";
import type { AnalysisInputFile } from "./analyzer.js";
import {
  ANALYSIS_IO_CONCURRENCY,
  MAX_ANALYSIS_BYTES,
  analysisBudgetSkipReason,
  type AnalysisCollectionOptions,
} from "./limits.js";

interface TreeEntry {
  mode: string;
  objectId: string;
}

const MAX_BASELINE_PATHS_PER_BATCH = 64;
const MAX_BASELINE_ARGUMENT_BYTES = 16 * 1024;

function isRegularFileMode(mode: string): boolean {
  return mode === "100644" || mode === "100755";
}

export async function collectStagedAnalysisInputFiles(
  repoRoot: string,
  config: AgentBlackBoxConfig,
  options: AnalysisCollectionOptions = {}
): Promise<AnalysisInputFile[]> {
  const changedFiles = await collectStagedChanges(repoRoot, config.exclude);
  if (changedFiles.length === 0) {
    return [];
  }

  const git = createGit(repoRoot);
  const indexEntries = new Map<string, TreeEntry>();
  const indexOutput = await git.raw(["ls-files", "--stage", "-z"]);
  for (const entry of indexOutput.split("\0")) {
    const match = /^([0-7]{6}) ([0-9a-f]{40,64}) 0\t([\s\S]+)$/.exec(entry);
    if (match) {
      const [, mode = "", objectId = "", filePath = ""] = match;
      indexEntries.set(normalizeRepoPath(filePath), { mode, objectId });
    }
  }

  const maxBytes = Math.min(config.maxFileSizeKb * 1024, MAX_ANALYSIS_BYTES);
  const entries = changedFiles.map((file) => (file.status === "deleted" ? undefined : indexEntries.get(file.path)));
  const blobs = await readRegularFileBlobs(repoRoot, entries, maxBytes, "staged", options);

  return changedFiles.map((file, index): AnalysisInputFile => {
    if (file.status === "deleted") {
      return file;
    }
    const indexEntry = entries[index];
    if (!indexEntry) {
      return { ...file, kind: "missing", analysisSkipReason: "No complete staged blob exists for this path." };
    }
    if (!isRegularFileMode(indexEntry.mode)) {
      return { ...file, kind: "not-file", analysisSkipReason: "The staged entry is not a regular file." };
    }

    return { ...file, ...blobs[index] };
  });
}

type AnalysisBlob = Pick<AnalysisInputFile, "kind" | "content" | "sizeBytes" | "analysisSkipReason">;

/** Classifies each bounded blob as it arrives; other positions stay `undefined`. */
async function readRegularFileBlobs(
  repoRoot: string,
  entries: ReadonlyArray<TreeEntry | undefined>,
  maxBytes: number,
  source: "staged" | "baseline",
  options: AnalysisCollectionOptions
): Promise<Array<AnalysisBlob | undefined>> {
  const positions: number[] = [];
  const objectIds: string[] = [];
  entries.forEach((entry, index) => {
    if (entry && isRegularFileMode(entry.mode)) {
      positions.push(index);
      objectIds.push(entry.objectId);
    }
  });

  const blobs = await readGitBlobs(repoRoot, objectIds, maxBytes, (blob): AnalysisBlob => {
    if (blob === null) {
      return { kind: "large", analysisSkipReason: `The ${source} blob exceeds ${maxBytes} bytes.` };
    }
    const size = source === "staged" ? { sizeBytes: blob.length } : {};
    if (isLikelyBinary(blob)) {
      return { ...size, kind: "binary", analysisSkipReason: `Binary-like ${source} content.` };
    }
    const content = blob.toString("utf8");
    if (options.contentBudget && !options.contentBudget.retain(content)) {
      return { kind: "unknown", analysisSkipReason: analysisBudgetSkipReason(options.contentBudget) };
    }
    return { ...size, kind: "text", content };
  });
  const byPosition: Array<AnalysisBlob | undefined> = new Array(entries.length).fill(undefined);
  positions.forEach((position, index) => {
    byPosition[position] = blobs[index];
  });
  return byPosition;
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
  commit: string,
  options: AnalysisCollectionOptions = {}
): Promise<AnalysisInputFile[]> {
  if (!/^[0-9a-f]{40,64}$/.test(commit)) {
    throw new Error("Baseline commit must be a full Git object ID.");
  }
  const git = createGit(repoRoot);
  const maxBytes = Math.min(config.maxFileSizeKb * 1024, MAX_ANALYSIS_BYTES);
  const samePathEntries = await findBaselineBlobs(
    git,
    commit,
    stagedFiles.filter((file) => file.status !== "deleted").map((file) => file.path)
  );
  const needsRenameLookup = stagedFiles.some((file) => file.status !== "deleted" && !samePathEntries.has(file.path));
  const renameSources = needsRenameLookup
    ? await collectBaselineRenameSources(git, commit, config.exclude)
    : new Map<string, string>();
  const sourcePaths = stagedFiles
    .filter((file) => file.status !== "deleted" && !samePathEntries.has(file.path))
    .map((file) => renameSources.get(file.path))
    .filter((sourcePath): sourcePath is string => sourcePath !== undefined);
  const sourceEntries = await findBaselineBlobs(git, commit, sourcePaths);

  const lookups = stagedFiles.map((file) => {
    let entry = file.status === "deleted" ? undefined : samePathEntries.get(file.path);
    let baselineSourcePath: string | undefined;
    if (file.status !== "deleted" && !entry) {
      const sourcePath = renameSources.get(file.path);
      if (sourcePath) {
        entry = sourceEntries.get(sourcePath);
        if (entry) {
          baselineSourcePath = sourcePath;
        }
      }
    }
    return { entry, baselineSourcePath };
  });
  const blobs = await readRegularFileBlobs(
    repoRoot,
    lookups.map((lookup) => lookup.entry),
    maxBytes,
    "baseline",
    options
  );

  return stagedFiles.map((file, index): AnalysisInputFile => {
    if (file.status === "deleted") {
      return { ...file, analysisSkipReason: "Deleted staged paths have no content finding to compare." };
    }
    const { entry, baselineSourcePath } = lookups[index] ?? {};
    if (!entry) {
      return { path: file.path, status: file.status, kind: "missing" };
    }
    if (!isRegularFileMode(entry.mode)) {
      return {
        path: file.path,
        status: file.status,
        kind: "not-file",
        analysisSkipReason: "The baseline entry is not a regular file.",
      };
    }
    return {
      path: file.path,
      status: file.status,
      ...blobs[index],
      ...(baselineSourcePath && blobs[index]?.kind === "text" ? { baselineSourcePath } : {}),
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
    const status = tokens[index++] ?? "";
    if (/^[RC]\d+$/.test(status)) {
      const source = normalizeRepoPath(tokens[index++] ?? "");
      const destination = normalizeRepoPath(tokens[index++] ?? "");
      if (status.startsWith("R") && source && destination && !isPathExcluded(source, excludePatterns)) {
        sources.set(destination, source);
      }
    } else {
      index += 1;
    }
  }
  return sources;
}

async function findBaselineBlobs(
  git: SimpleGit,
  commit: string,
  paths: readonly string[]
): Promise<Map<string, TreeEntry>> {
  const batches: string[][] = [];
  let batch: string[] = [];
  // Reserve room for fixed arguments; doubling each UTF-8 pathspec also allows for command-line quoting.
  let argumentBytes = 1024;
  for (const filePath of new Set(paths)) {
    const pathspecBytes = Buffer.byteLength(`:(top,literal)${filePath}`) * 2 + 3;
    if (
      batch.length > 0 &&
      (batch.length >= MAX_BASELINE_PATHS_PER_BATCH || argumentBytes + pathspecBytes > MAX_BASELINE_ARGUMENT_BYTES)
    ) {
      batches.push(batch);
      batch = [];
      argumentBytes = 1024;
    }
    // A single unusually long path retains its existing Git behavior rather than introducing a new path limit.
    batch.push(filePath);
    argumentBytes += pathspecBytes;
  }
  if (batch.length > 0) {
    batches.push(batch);
  }

  const results = await mapWithConcurrency(batches, ANALYSIS_IO_CONCURRENCY, async (filePaths) => {
    const requestedPaths = new Set(filePaths);
    const tree = await git.raw([
      "ls-tree",
      "-r",
      "-z",
      commit,
      "--",
      ...filePaths.map((filePath) => `:(top,literal)${filePath}`),
    ]);
    const entries = new Map<string, TreeEntry>();
    for (const item of tree.split("\0")) {
      const match = /^([0-7]{6}) blob ([0-9a-f]{40,64})\t([\s\S]+)$/.exec(item);
      const [, mode = "", objectId = "", itemPath = ""] = match ?? [];
      const filePath = normalizeRepoPath(itemPath);
      if (match && requestedPaths.has(filePath)) {
        entries.set(filePath, { mode, objectId });
      }
    }
    return entries;
  });
  const entries = new Map<string, TreeEntry>();
  for (const result of results) {
    for (const [filePath, entry] of result) {
      entries.set(filePath, entry);
    }
  }
  return entries;
}
