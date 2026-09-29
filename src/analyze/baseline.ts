import {
  analyzeChangedFiles,
  summarizeAnalysisFindings,
  type AnalysisInputFile,
  type WatcherlessAnalysisResult,
} from "./analyzer.js";

export function compareAnalysisWithBaseline(
  stagedFiles: readonly AnalysisInputFile[],
  baselineFiles: readonly AnalysisInputFile[],
  current: WatcherlessAnalysisResult,
  commit: string
): WatcherlessAnalysisResult {
  const existingSecretLines = new Map<string, Map<string, number>>();
  const stagedLines = new Map<string, string[]>();
  let scannedTextFiles = 0;
  let absentFiles = 0;
  const skipped: Array<{ path: string; reason: string }> = [];
  const renameSources = baselineFiles
    .filter((file) => file.kind === "text" && file.baselineSourcePath)
    .map((file) => ({ path: file.path, sourcePath: file.baselineSourcePath!, suppressedExistingSecrets: 0 }));
  const renameSourcesByPath = new Map(renameSources.map((source) => [source.path, source]));

  for (const file of baselineFiles) {
    if (file.status === "deleted") {
      continue;
    }
    if (file.kind === "missing") {
      absentFiles += 1;
      continue;
    }
    if (file.kind !== "text" || file.content === undefined) {
      skipped.push({ path: file.path, reason: file.analysisSkipReason ?? "Baseline text content was unavailable." });
      continue;
    }

    scannedTextFiles += 1;
    const lines = file.content.split(/\r?\n/);
    const counts = new Map<string, number>();
    for (const finding of analyzeChangedFiles([file]).findings) {
      if (finding.kind !== "possible-secret" || finding.line === undefined) {
        continue;
      }
      const line = lines[finding.line - 1];
      if (line !== undefined) {
        counts.set(line, (counts.get(line) ?? 0) + 1);
      }
    }
    existingSecretLines.set(file.path, counts);
  }

  for (const file of stagedFiles) {
    if (file.content !== undefined) {
      stagedLines.set(file.path, file.content.split(/\r?\n/));
    }
  }

  let suppressedExistingSecrets = 0;
  const findings = current.findings.filter((finding) => {
    if (finding.kind !== "possible-secret" || finding.line === undefined) {
      return true;
    }
    const line = stagedLines.get(finding.path)?.[finding.line - 1];
    if (line === undefined) {
      return true;
    }
    const counts = existingSecretLines.get(finding.path);
    const remaining = counts?.get(line) ?? 0;
    if (remaining === 0) {
      return true;
    }
    counts?.set(line, remaining - 1);
    suppressedExistingSecrets += 1;
    const renameSource = renameSourcesByPath.get(finding.path);
    if (renameSource) {
      renameSource.suppressedExistingSecrets += 1;
    }
    return false;
  });

  return {
    ...current,
    findings,
    summary: summarizeAnalysisFindings(findings),
    baselineComparison: { commit, suppressedExistingSecrets, scannedTextFiles, absentFiles, skipped, renameSources },
  };
}
