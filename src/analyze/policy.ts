import type { AnalysisInputFile, WatcherlessAnalysisResult } from "./analyzer.js";
import type { ConfiguredAnalysisPolicies, ConfiguredAnalysisPolicy } from "../types.js";
import { normalizeAnalysisPolicies } from "../config/analysisPolicies.js";
import { severityRank } from "../utils/severity.js";

export type AnalysisPolicyProfile = string;

export interface AnalysisPolicyEvaluation {
  profile: AnalysisPolicyProfile;
  failed: boolean;
  newSecretCount: number;
  skippedStagedFiles: number;
  skippedBaselineFiles: number;
  /** Present when one or more staged or baseline files were only partially scanned. */
  limitedStagedFiles?: number;
  limitedBaselineFiles?: number;
  /** Custom profiles only: metadata risks matching the severity and category gates. */
  severityRiskCount?: number;
}

export function parseAnalysisPolicyProfile(
  value: string | undefined,
  configuredPolicies?: ConfiguredAnalysisPolicies
): AnalysisPolicyProfile | undefined {
  if (value === undefined) {
    return value;
  }
  const policies = validateConfiguredPolicies(configuredPolicies);
  if (value === "new-secrets" || value === "complete-review" || Object.hasOwn(policies, value)) {
    return value;
  }
  throw new Error(
    `--policy must be one of: ${["new-secrets", "complete-review", ...Object.keys(policies)].join(", ")}.`
  );
}

export function evaluateAnalysisPolicy(
  result: WatcherlessAnalysisResult,
  stagedFiles: readonly AnalysisInputFile[],
  profile: AnalysisPolicyProfile,
  configuredPolicies?: ConfiguredAnalysisPolicies
): AnalysisPolicyEvaluation {
  if (result.coverage?.source !== "index" || (!result.baselineComparison && result.initialCommitAnalysis !== true)) {
    throw new Error("--policy requires --staged and --baseline.");
  }

  const newSecretCount = result.findings.filter((finding) => finding.kind === "possible-secret").length;
  const skippedStagedFiles = stagedFiles.filter(
    (file) => file.status !== "deleted" && (file.kind !== "text" || file.content === undefined)
  ).length;
  const skippedBaselineFiles = result.baselineComparison?.skipped.length ?? 0;
  const limitedStagedFiles = new Set([
    ...result.findings.filter((finding) => finding.kind === "analysis-limit").map((finding) => finding.path),
    ...(result.coverage.limited ?? []).map((file) => file.path),
  ]).size;
  const limitedBaselineFiles = new Set((result.baselineComparison?.limited ?? []).map((file) => file.path)).size;
  const policies = validateConfiguredPolicies(configuredPolicies);
  const builtInProfile = profile === "new-secrets" || profile === "complete-review";
  let configuredPolicy: ConfiguredAnalysisPolicy | undefined;
  if (!builtInProfile) {
    if (!Object.hasOwn(policies, profile)) {
      throw new Error(`Unknown analysis policy "${profile}".`);
    }
    configuredPolicy = policies[profile];
  }
  const minSeverity = configuredPolicy?.minSeverity;
  const categories = configuredPolicy?.categories;
  const severityRiskCount = minSeverity
    ? result.findings.filter(
        (finding) =>
          finding.kind === "metadata-risk" &&
          severityRank(finding.severity) >= severityRank(minSeverity) &&
          (!categories || categories.some((category) => category.toLowerCase() === finding.category.toLowerCase()))
      ).length
    : 0;
  const failOnNewSecrets = configuredPolicy?.failOnNewSecrets ?? true;
  const requireCompleteCoverage = configuredPolicy?.requireCompleteCoverage ?? profile === "complete-review";
  return {
    profile,
    failed:
      (failOnNewSecrets && newSecretCount > 0) ||
      (requireCompleteCoverage &&
        (skippedStagedFiles > 0 || skippedBaselineFiles > 0 || limitedStagedFiles > 0 || limitedBaselineFiles > 0)) ||
      severityRiskCount > 0,
    newSecretCount,
    skippedStagedFiles,
    skippedBaselineFiles,
    ...(limitedStagedFiles > 0 || limitedBaselineFiles > 0 ? { limitedStagedFiles, limitedBaselineFiles } : {}),
    ...(builtInProfile ? {} : { severityRiskCount }),
  };
}

function validateConfiguredPolicies(value: ConfiguredAnalysisPolicies | undefined): ConfiguredAnalysisPolicies {
  const errors: string[] = [];
  const normalized = normalizeAnalysisPolicies(value, errors);
  if (errors.length > 0) {
    throw new Error(`Invalid analysisPolicies: ${errors.join(" ")}`);
  }
  return normalized.analysisPolicies ?? {};
}
