import type {
  ChangedFile,
  FileChangeEvidence,
  FileEvent,
  GitSnapshot,
  SessionBaseline,
  SessionChangeEvidence
} from "../types.js";
import { normalizePath } from "../utils/paths.js";

export function buildChangeEvidence(
  baseline: SessionBaseline | null,
  events: FileEvent[],
  finalGit: GitSnapshot,
  committedChanges: ChangedFile[] = []
): SessionChangeEvidence {
  const startByPath = new Map((baseline?.git.changedFiles ?? []).map((file) => [file.path, file]));
  const endByPath = new Map(finalGit.changedFiles.map((file) => [file.path, file]));
  const observedPaths = new Set(events.map((event) => normalizePath(event.path)));
  const paths = [...new Set([...startByPath.keys(), ...observedPaths, ...endByPath.keys()])].sort();

  return {
    baselineAvailable: baseline !== null,
    ...(baseline ? { baselineCapturedAt: baseline.capturedAt } : {}),
    headChanged: baseline ? baseline.git.head !== finalGit.head : null,
    indexChanged: baseline ? baseline.git.indexFingerprint !== finalGit.indexFingerprint : null,
    branchChanged: baseline ? baseline.git.branch !== finalGit.branch : null,
    committedChanges,
    files: paths.map((filePath) => {
      const start = startByPath.get(filePath);
      const end = endByPath.get(filePath);
      return {
        path: filePath,
        atStart: baseline ? start !== undefined : null,
        observedDuringSession: observedPaths.has(filePath),
        atEnd: end !== undefined,
        gitMetadataChanged: baseline ? !sameGitMetadata(start, end) : null
      };
    })
  };
}

export function selectSessionRelevantChanges(
  finalGit: GitSnapshot,
  evidence: SessionChangeEvidence
): ChangedFile[] {
  const evidenceByPath = new Map(evidence.files.map((file) => [file.path, file]));
  const relevantFinalChanges = !evidence.baselineAvailable || evidence.indexChanged
    ? finalGit.changedFiles
    : finalGit.changedFiles.filter((file) => isSessionRelevant(evidenceByPath.get(file.path)));
  const changesByPath = new Map(evidence.committedChanges.map((file) => [file.path, file]));
  for (const file of relevantFinalChanges) {
    changesByPath.set(file.path, file);
  }

  return [...changesByPath.values()];
}

export function findFileChangeEvidence(
  evidence: SessionChangeEvidence | undefined,
  filePath: string
): FileChangeEvidence | undefined {
  return evidence?.files.find((file) => file.path === filePath);
}

export function indexFileChangeEvidence(
  evidence: SessionChangeEvidence | undefined
): Map<string, FileChangeEvidence> {
  return new Map((evidence?.files ?? []).map((file) => [file.path, file]));
}

function isSessionRelevant(evidence: FileChangeEvidence | undefined): boolean {
  if (!evidence) {
    return true;
  }

  return evidence.atStart === false || evidence.observedDuringSession || evidence.gitMetadataChanged === true;
}

function sameGitMetadata(start: ChangedFile | undefined, end: ChangedFile | undefined): boolean {
  if (!start || !end) {
    return start === end;
  }

  return (
    start.status === end.status &&
    start.insertions === end.insertions &&
    start.deletions === end.deletions &&
    start.kind === end.kind &&
    start.sizeBytes === end.sizeBytes &&
    start.lineStatsSource === end.lineStatsSource
  );
}
