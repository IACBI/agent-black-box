import type { ChangedFile } from "../types.js";
import { mapWithConcurrency } from "../utils/concurrency.js";
import { inspectTextFile } from "../utils/fileInspection.js";
import { resolveRepoPath } from "../utils/paths.js";
import type { AnalysisCoverage, AnalysisInputFile } from "./analyzer.js";
import {
  ANALYSIS_IO_CONCURRENCY,
  MAX_ANALYSIS_BYTES,
  analysisBudgetSkipReason,
  type AnalysisCollectionOptions,
} from "./limits.js";

/** Reads the current working-tree content of changed files for watcherless analysis. */
export async function collectAnalysisInputFiles(
  repoRoot: string,
  changedFiles: ReadonlyArray<ChangedFile>,
  maxFileSizeBytes: number,
  options: AnalysisCollectionOptions = {}
): Promise<AnalysisInputFile[]> {
  const safeMaxFileSizeBytes = Math.min(maxFileSizeBytes, MAX_ANALYSIS_BYTES);
  // Admissions follow input order; one bounded read is transient while the shared quota is active.
  const concurrency = options.contentBudget ? 1 : ANALYSIS_IO_CONCURRENCY;
  return mapWithConcurrency(changedFiles, concurrency, async (file) => {
    if (file.status === "deleted") {
      return file;
    }

    const absolutePath = resolveRepoPath(repoRoot, file.path);
    if (!absolutePath) {
      return file;
    }

    const inspection = await inspectTextFile(absolutePath, safeMaxFileSizeBytes, safeMaxFileSizeBytes, repoRoot);
    if (inspection.text !== undefined && options.contentBudget && !options.contentBudget.retain(inspection.text)) {
      return { ...file, kind: "unknown", analysisSkipReason: analysisBudgetSkipReason(options.contentBudget) };
    }
    return {
      ...file,
      kind: inspection.kind,
      ...(inspection.reason === undefined ? {} : { analysisSkipReason: inspection.reason }),
      ...(inspection.text === undefined ? {} : { content: inspection.text }),
    };
  });
}

/** Counts scanned files and lists, with a reason, every changed path whose content was not scanned. */
export function summarizeAnalysisCoverage(
  files: readonly AnalysisInputFile[],
  source: AnalysisCoverage["source"]
): AnalysisCoverage {
  let scannedTextFiles = 0;
  const skipped: AnalysisCoverage["skipped"] = [];
  for (const file of files) {
    if (file.status === "deleted") {
      skipped.push({ path: file.path, reason: "Deleted files have no current content to scan." });
    } else if (file.kind === "text" && file.content !== undefined) {
      scannedTextFiles += 1;
    } else {
      skipped.push({
        path: file.path,
        reason: file.analysisSkipReason ?? "Text content was unavailable for this changed path.",
      });
    }
  }
  return { source, scannedTextFiles, skipped };
}
