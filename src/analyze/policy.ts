import type { AnalysisInputFile, WatcherlessAnalysisResult } from "./analyzer.js";

export type AnalysisPolicyProfile = "new-secrets" | "complete-review";

export interface AnalysisPolicyEvaluation {
  profile: AnalysisPolicyProfile;
  failed: boolean;
  newSecretCount: number;
  skippedStagedFiles: number;
  skippedBaselineFiles: number;
}

export function parseAnalysisPolicyProfile(value: string | undefined): AnalysisPolicyProfile | undefined {
  if (value === undefined || value === "new-secrets" || value === "complete-review") {
    return value;
  }
  throw new Error("--policy must be one of: new-secrets, complete-review.");
}

export function evaluateAnalysisPolicy(
  result: WatcherlessAnalysisResult,
  stagedFiles: readonly AnalysisInputFile[],
  profile: AnalysisPolicyProfile
): AnalysisPolicyEvaluation {
  if (result.coverage?.source !== "index" || !result.baselineComparison) {
    throw new Error("--policy requires --staged and --baseline.");
  }

  const newSecretCount = result.findings.filter((finding) => finding.kind === "possible-secret").length;
  const skippedStagedFiles = stagedFiles.filter(
    (file) => file.status !== "deleted" && (file.kind !== "text" || file.content === undefined)
  ).length;
  const skippedBaselineFiles = result.baselineComparison.skipped.length;
  return {
    profile,
    failed:
      newSecretCount > 0 || (profile === "complete-review" && (skippedStagedFiles > 0 || skippedBaselineFiles > 0)),
    newSecretCount,
    skippedStagedFiles,
    skippedBaselineFiles,
  };
}
