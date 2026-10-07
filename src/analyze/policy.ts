import type { AnalysisInputFile, WatcherlessAnalysisResult } from "./analyzer.js";
import type { ConfiguredAnalysisPolicies, ConfiguredAnalysisPolicy, RiskSeverity } from "../types.js";
import { normalizeAnalysisPolicies } from "../config/analysisPolicies.js";

export type AnalysisPolicyProfile = string;

export interface AnalysisPolicyEvaluation {
  profile: AnalysisPolicyProfile;
  failed: boolean;
  newSecretCount: number;
  skippedStagedFiles: number;
  skippedBaselineFiles: number;
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
  if (result.coverage?.source !== "index" || !result.baselineComparison) {
    throw new Error("--policy requires --staged and --baseline.");
  }

  const newSecretCount = result.findings.filter((finding) => finding.kind === "possible-secret").length;
  const skippedStagedFiles = stagedFiles.filter(
    (file) => file.status !== "deleted" && (file.kind !== "text" || file.content === undefined)
  ).length;
  const skippedBaselineFiles = result.baselineComparison.skipped.length;
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
      (requireCompleteCoverage && (skippedStagedFiles > 0 || skippedBaselineFiles > 0)) ||
      severityRiskCount > 0,
    newSecretCount,
    skippedStagedFiles,
    skippedBaselineFiles,
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

function severityRank(severity: RiskSeverity): number {
  switch (severity) {
    case "low":
      return 1;
    case "medium":
      return 2;
    case "high":
      return 3;
  }
}
