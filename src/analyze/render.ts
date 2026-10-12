import {
  sarifArtifactUri,
  sarifLevel,
  SARIF_SCHEMA_URL,
  SARIF_VERSION,
  TOOL_INFORMATION_URI,
} from "../reports/sarif.js";
import { formatTerminalValue } from "../utils/terminal.js";
import type { AnalysisFinding, WatcherlessAnalysisResult } from "./analyzer.js";

export type AnalyzeFormat = "text" | "json" | "sarif";

export function parseAnalyzeFormat(value: string): AnalyzeFormat {
  if (value === "text" || value === "json" || value === "sarif") {
    return value;
  }
  throw new Error("--format must be one of: text, json, sarif.");
}

/** Renders an analysis result as terminal-safe text, JSON, or a SARIF 2.1.0 log. */
export function renderAnalysis(result: WatcherlessAnalysisResult, format: AnalyzeFormat): string {
  if (format === "json") {
    return JSON.stringify(result, null, 2);
  }
  if (format === "sarif") {
    return JSON.stringify(toAnalysisSarif(result), null, 2);
  }

  const lines = ["Agent Black Box Analysis", "", `Findings: ${result.summary.findingCount}`];
  lines.push(`Maximum severity: ${result.summary.maxSeverity}`);
  lines.push(`Score: ${result.summary.score}`);
  if (result.initialCommitAnalysis === true) {
    lines.push("Initial commit analysis: all staged content is new; no baseline commit exists.");
  }
  if (result.secretAllowlist) {
    lines.push(`Secret findings hidden by the configured allowlist: ${result.secretAllowlist.suppressedFindings}.`);
  }
  if (result.coverage) {
    lines.push(`Content scanned: ${result.coverage.scannedTextFiles} ${result.coverage.source} file(s).`);
    lines.push(`Content skipped: ${result.coverage.skipped.length} file(s).`);
    if (result.coverage.limited) {
      lines.push(`Custom-pattern content limited: ${result.coverage.limited.length} file(s).`);
      lines.push(...result.coverage.limited.slice(0, 20).map(renderSkippedFile));
    }
    if (result.coverage.skipped.length > 0) {
      lines.push(...result.coverage.skipped.slice(0, 20).map(renderSkippedFile));
      if (result.coverage.skipped.length > 20) {
        lines.push(`- ${result.coverage.skipped.length - 20} additional skipped file(s) omitted from text output.`);
      }
    }
  }
  if (result.baselineComparison) {
    const comparison = result.baselineComparison;
    lines.push(`Baseline commit: ${comparison.commit}`);
    lines.push(`Existing secret findings suppressed: ${comparison.suppressedExistingSecrets}.`);
    lines.push(`Baseline text scanned: ${comparison.scannedTextFiles} file(s).`);
    lines.push(`Absent at baseline: ${comparison.absentFiles} file(s).`);
    lines.push(`Baseline content skipped: ${comparison.skipped.length} file(s).`);
    if (comparison.limited) {
      lines.push(`Baseline content limited: ${comparison.limited.length} file(s).`);
      lines.push(...comparison.limited.slice(0, 20).map(renderSkippedFile));
    }
    lines.push(...comparison.skipped.slice(0, 20).map(renderSkippedFile));
    lines.push(`Baseline rename sources: ${comparison.renameSources.length} file(s).`);
    lines.push(
      ...comparison.renameSources
        .slice(0, 20)
        .map(
          (source) =>
            `- ${formatTerminalValue(source.path)} <- ${formatTerminalValue(source.sourcePath)}: ${source.suppressedExistingSecrets} suppressed.`
        )
    );
  }
  if (result.policyEvaluation) {
    const evaluation = result.policyEvaluation;
    lines.push(`Policy ${formatTerminalValue(evaluation.profile)}: ${evaluation.failed ? "failed" : "passed"}.`);
    lines.push(`New secret findings: ${evaluation.newSecretCount}.`);
    if (evaluation.profile === "complete-review" || evaluation.severityRiskCount !== undefined) {
      lines.push(`Skipped staged content: ${evaluation.skippedStagedFiles} file(s).`);
      lines.push(`Skipped baseline content: ${evaluation.skippedBaselineFiles} file(s).`);
    }
    if (evaluation.limitedStagedFiles !== undefined) {
      lines.push(`Partially scanned staged content: ${evaluation.limitedStagedFiles} file(s).`);
      lines.push(`Partially scanned baseline content: ${evaluation.limitedBaselineFiles} file(s).`);
    }
    if (evaluation.severityRiskCount !== undefined) {
      lines.push(`Risk findings matching the policy threshold/categories: ${evaluation.severityRiskCount}.`);
    }
  }
  if (result.findings.length > 0) {
    const baselineSourcePaths = getBaselineSourcePaths(result);
    lines.push("");
    for (const finding of result.findings) {
      lines.push(renderAnalysisFinding(finding, baselineSourcePaths.get(finding.path)));
    }
  }
  return lines.join("\n");
}

function renderSkippedFile(file: { path: string; reason: string }): string {
  return `- ${formatTerminalValue(file.path)}: ${formatTerminalValue(file.reason)}`;
}

function getBaselineSourcePaths(result: WatcherlessAnalysisResult): Map<string, string> {
  return new Map((result.baselineComparison?.renameSources ?? []).map((source) => [source.path, source.sourcePath]));
}

function renderAnalysisFinding(finding: AnalysisFinding, baselineSourcePath?: string): string {
  const line = finding.line === undefined ? "" : `:${finding.line}`;
  const source =
    baselineSourcePath === undefined ? "" : ` (baseline source: ${formatTerminalValue(baselineSourcePath)})`;
  return `[${finding.severity}] ${formatTerminalValue(finding.path)}${line}${source} — ${formatTerminalValue(finding.category)}: ${formatTerminalValue(finding.reason)}`;
}

/** Builds the SARIF log for `abb analyze --format sarif`. Exported for tests. */
export function toAnalysisSarif(result: WatcherlessAnalysisResult): Record<string, unknown> {
  const baselineSourcePaths = getBaselineSourcePaths(result);
  const properties = {
    ...(result.initialCommitAnalysis === true ? { initialCommitAnalysis: true } : {}),
    ...(result.coverage ? { analysisCoverage: result.coverage } : {}),
    ...(result.baselineComparison ? { analysisBaselineComparison: result.baselineComparison } : {}),
    ...(result.policyEvaluation ? { analysisPolicy: result.policyEvaluation } : {}),
    ...(result.secretAllowlist ? { secretAllowlist: result.secretAllowlist } : {}),
  };
  return {
    version: SARIF_VERSION,
    $schema: SARIF_SCHEMA_URL,
    runs: [
      {
        ...(Object.keys(properties).length > 0 ? { properties } : {}),
        tool: {
          driver: {
            name: "Agent Black Box",
            informationUri: TOOL_INFORMATION_URI,
            rules: [...new Set(result.findings.map((finding) => `${finding.kind}:${finding.category}`))].map((id) => ({
              id,
            })),
          },
        },
        results: result.findings.map((finding) => {
          const baselineSourcePath = baselineSourcePaths.get(finding.path);
          return {
            ruleId: `${finding.kind}:${finding.category}`,
            level: sarifLevel(finding.severity),
            message: { text: finding.reason },
            locations: [
              {
                physicalLocation: {
                  artifactLocation: { uri: sarifArtifactUri(finding.path) },
                  ...(finding.line === undefined ? {} : { region: { startLine: finding.line } }),
                },
              },
            ],
            ...(baselineSourcePath === undefined ? {} : { properties: { baselineSourcePath } }),
          };
        }),
      },
    ],
  };
}
