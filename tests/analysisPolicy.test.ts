import { describe, expect, it } from "vitest";
import { analyzeChangedFiles, type AnalysisInputFile } from "../src/analyze/analyzer.js";
import { evaluateAnalysisPolicy, parseAnalysisPolicyProfile } from "../src/analyze/policy.js";
import type { ConfiguredAnalysisPolicies } from "../src/types.js";

describe("staged analysis policies", () => {
  const staged: AnalysisInputFile[] = [
    { path: "settings.ts", status: "modified", kind: "text", content: "const apiKey = process.env.API_KEY;\n" },
    { path: "large.bin", status: "added", kind: "large" },
    { path: "removed.ts", status: "deleted" },
  ];
  const base = {
    ...analyzeChangedFiles(staged),
    coverage: { source: "index" as const, scannedTextFiles: 1, skipped: [] },
    baselineComparison: {
      commit: "a".repeat(40),
      suppressedExistingSecrets: 0,
      scannedTextFiles: 0,
      absentFiles: 0,
      skipped: [{ path: "settings.ts", reason: "Baseline content unavailable." }],
      renameSources: [],
    },
  };

  it("allows review of incomplete coverage or fails closed by selected profile", () => {
    expect(evaluateAnalysisPolicy(base, staged, "new-secrets")).toMatchObject({
      failed: false,
      newSecretCount: 0,
      skippedStagedFiles: 1,
      skippedBaselineFiles: 1,
    });
    expect(evaluateAnalysisPolicy(base, staged, "complete-review").failed).toBe(true);
  });

  it("fails both profiles for new secret findings", () => {
    const secret = analyzeChangedFiles([
      { path: "settings.ts", status: "modified", kind: "text", content: 'const apiKey = "test_credential_987654321";' },
    ]).findings;
    const result = { ...base, findings: secret };
    expect(evaluateAnalysisPolicy(result, staged, "new-secrets").failed).toBe(true);
    expect(evaluateAnalysisPolicy(result, staged, "complete-review").newSecretCount).toBe(1);
  });

  it("rejects unknown profiles and analysis without a staged baseline", () => {
    expect(() => parseAnalysisPolicyProfile("permissive")).toThrow("--policy must be one of");
    expect(() => evaluateAnalysisPolicy(analyzeChangedFiles(staged), staged, "new-secrets")).toThrow(
      "requires --staged and --baseline"
    );
  });

  it("retains the exact built-in evaluation contract with configured profiles available", () => {
    const configured = { team: { minSeverity: "low" as const } };
    expect(evaluateAnalysisPolicy(base, staged, "new-secrets", configured)).toEqual({
      profile: "new-secrets",
      failed: false,
      newSecretCount: 0,
      skippedStagedFiles: 1,
      skippedBaselineFiles: 1,
    });
    expect(evaluateAnalysisPolicy(base, staged, "complete-review", configured)).toEqual({
      profile: "complete-review",
      failed: true,
      newSecretCount: 0,
      skippedStagedFiles: 1,
      skippedBaselineFiles: 1,
    });
  });

  it("only resolves configured own names and fails closed for typos or reserved overrides", () => {
    expect(parseAnalysisPolicyProfile("team", { team: {} })).toBe("team");
    expect(parseAnalysisPolicyProfile("constructor", { constructor: {} })).toBe("constructor");
    expect(() => parseAnalysisPolicyProfile("constructor", {})).toThrow("--policy must be one of");
    expect(() => parseAnalysisPolicyProfile("team", Object.create({ team: {} }))).toThrow("--policy must be one of");
    expect(() => evaluateAnalysisPolicy(base, staged, "typo", { team: {} })).toThrow("Unknown analysis policy");
    const override = { "new-secrets": { failOnNewSecrets: false } };
    expect(() => parseAnalysisPolicyProfile("new-secrets", override)).toThrow("cannot override");
    expect(() => evaluateAnalysisPolicy(base, staged, "new-secrets", override)).toThrow("cannot override");
    expect(() =>
      parseAnalysisPolicyProfile("team", {
        team: { failOnNewSecrets: "false" },
      } as unknown as ConfiguredAnalysisPolicies)
    ).toThrow("must be a boolean");
  });

  it("applies custom severity/category gates exactly and case-insensitively to metadata risks", () => {
    const findings = [
      {
        path: "config.ts",
        kind: "metadata-risk" as const,
        category: "Config file",
        severity: "medium" as const,
        score: 60,
        reason: "Configuration changed.",
      },
      {
        path: "missing.ts",
        kind: "analysis-limit" as const,
        category: "Config file",
        severity: "high" as const,
        score: 90,
        reason: "Content unavailable.",
      },
    ];
    const result = { ...base, findings };
    expect(
      evaluateAnalysisPolicy(result, staged, "team", { team: { minSeverity: "medium", categories: ["config FILE"] } })
    ).toMatchObject({ failed: true, severityRiskCount: 1 });
    expect(
      evaluateAnalysisPolicy(result, staged, "team", { team: { minSeverity: "high", categories: ["Config file"] } })
    ).toMatchObject({ failed: false, severityRiskCount: 0 });
    expect(
      evaluateAnalysisPolicy(result, staged, "team", { team: { minSeverity: "low", categories: ["Config"] } })
    ).toMatchObject({ failed: false, severityRiskCount: 0 });
    expect(evaluateAnalysisPolicy(result, staged, "team", { team: { minSeverity: "low" } })).toMatchObject({
      failed: true,
      severityRiskCount: 1,
    });
  });

  it("keeps secret and coverage gates independent of category filters", () => {
    const secret = analyzeChangedFiles([
      { path: "settings.ts", status: "modified", kind: "text", content: 'const apiKey = "test_credential_987654321";' },
    ]).findings;
    const configured = { team: { minSeverity: "high" as const, categories: ["Unrelated category"] } };
    expect(evaluateAnalysisPolicy({ ...base, findings: secret }, staged, "team", configured)).toMatchObject({
      failed: true,
      newSecretCount: 1,
      severityRiskCount: 0,
    });
    expect(
      evaluateAnalysisPolicy(base, staged, "team", { team: { ...configured.team, requireCompleteCoverage: true } })
    ).toMatchObject({ failed: true, skippedStagedFiles: 1, skippedBaselineFiles: 1 });
    expect(
      evaluateAnalysisPolicy({ ...base, findings: secret }, staged, "team", {
        team: { ...configured.team, failOnNewSecrets: false },
      })
    ).toMatchObject({ failed: false, newSecretCount: 1, severityRiskCount: 0 });
  });

  it("uses secure defaults and excludes deleted paths from required content coverage", () => {
    expect(evaluateAnalysisPolicy(base, staged, "team", { team: {} })).toMatchObject({
      failed: false,
      severityRiskCount: 0,
    });
    const onlyDeleted: AnalysisInputFile[] = [{ path: "removed.ts", status: "deleted" }];
    const result = { ...base, findings: [], baselineComparison: { ...base.baselineComparison, skipped: [] } };
    expect(
      evaluateAnalysisPolicy(result, onlyDeleted, "team", { team: { requireCompleteCoverage: true } })
    ).toMatchObject({ failed: false, skippedStagedFiles: 0, skippedBaselineFiles: 0 });
    expect(() => evaluateAnalysisPolicy(analyzeChangedFiles(staged), staged, "team", { team: {} })).toThrow(
      "requires --staged and --baseline"
    );
  });
});
