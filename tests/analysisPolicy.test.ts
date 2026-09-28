import { describe, expect, it } from "vitest";
import { analyzeChangedFiles, type AnalysisInputFile } from "../src/analyze/analyzer.js";
import { evaluateAnalysisPolicy, parseAnalysisPolicyProfile } from "../src/analyze/policy.js";

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
});
