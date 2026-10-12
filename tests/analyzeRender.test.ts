import { describe, expect, it } from "vitest";
import {
  analyzeChangedFiles,
  type AnalysisInputFile,
  type WatcherlessAnalysisResult,
} from "../src/analyze/analyzer.js";
import { compareAnalysisWithBaseline } from "../src/analyze/baseline.js";
import { parseAnalyzeFormat, renderAnalysis, toAnalysisSarif } from "../src/analyze/render.js";

function sampleResult(): WatcherlessAnalysisResult {
  return analyzeChangedFiles([
    { path: "src/auth/session ü#1.ts", status: "modified", kind: "text", content: 'const apiKey = "abcdef123456";\n' },
    { path: "pnpm-lock.yaml", status: "modified" },
  ]);
}

function renamedResult(sourcePath = "src/old-auth.ts"): WatcherlessAnalysisResult {
  const existingLine = 'const apiKey = "existing_test_credential";\n';
  const renamed: AnalysisInputFile = {
    path: "src/auth/renamed.ts",
    status: "renamed",
    kind: "text",
    content: `${existingLine}const password = "new_test_credential";\n`,
  };
  const staged: AnalysisInputFile[] = [renamed, { path: "pnpm-lock.yaml", status: "modified" }];
  return compareAnalysisWithBaseline(
    staged,
    [{ ...renamed, content: existingLine, baselineSourcePath: sourcePath }],
    analyzeChangedFiles(staged),
    "a".repeat(40)
  );
}

describe("analysis output", () => {
  it("accepts exactly the three documented formats", () => {
    expect(parseAnalyzeFormat("text")).toBe("text");
    expect(parseAnalyzeFormat("json")).toBe("json");
    expect(parseAnalyzeFormat("sarif")).toBe("sarif");
    expect(() => parseAnalyzeFormat("xml")).toThrow("--format must be one of: text, json, sarif.");
    expect(() => parseAnalyzeFormat("SARIF")).toThrow("--format must be one of");
  });

  it("renders JSON identical to the result and never echoes matched content", () => {
    const result = sampleResult();
    const rendered = renderAnalysis(result, "json");

    expect(JSON.parse(rendered)).toEqual(result);
    expect(rendered).not.toContain("abcdef123456");
  });

  it("identifies an initial staged analysis without manufacturing a baseline", () => {
    const result: WatcherlessAnalysisResult = {
      ...sampleResult(),
      coverage: { source: "index", scannedTextFiles: 1, skipped: [] },
      initialCommitAnalysis: true,
    };
    const text = renderAnalysis(result, "text");
    const sarif = toAnalysisSarif(result) as { runs: Array<{ properties: Record<string, unknown> }> };

    expect(text).toContain("Initial commit analysis: all staged content is new; no baseline commit exists.");
    expect(text).not.toContain("Baseline commit:");
    expect(text).not.toContain("Existing secret findings suppressed:");
    expect(sarif.runs[0].properties.initialCommitAnalysis).toBe(true);
    expect(sarif.runs[0].properties).not.toHaveProperty("analysisBaselineComparison");
    expect(JSON.parse(renderAnalysis(result, "json"))).toEqual(result);
    expect(renderAnalysis(sampleResult(), "text")).not.toContain("Initial commit analysis:");
  });

  it("renders a readable text report with locations and escapes control characters in paths", () => {
    const result = analyzeChangedFiles([
      { path: "src/a\u001b[2J.ts", status: "modified", kind: "text", content: 'password = "hunter2hunter2"\n' },
    ]);
    const text = renderAnalysis(result, "text");

    expect(text).toContain("Agent Black Box Analysis");
    expect(text).toContain("Findings: 1");
    expect(text).toContain("Maximum severity: high");
    expect(text).toContain(":1 — Possible secret:");
    expect(text).not.toContain("\u001b");
    expect(text).not.toContain("hunter2hunter2");
  });

  it("adds verified rename context to remaining findings without changing JSON or exposing credentials", () => {
    const result = renamedResult();
    const text = renderAnalysis(result, "text");

    expect(result.baselineComparison?.suppressedExistingSecrets).toBe(1);
    expect(text).toContain("[high] src/auth/renamed.ts:2 (baseline source: src/old-auth.ts) — Possible secret:");
    expect(text).toContain("[medium] pnpm-lock.yaml — Lockfile:");
    expect(text).not.toContain("existing_test_credential");
    expect(text).not.toContain("new_test_credential");
    expect(JSON.parse(renderAnalysis(result, "json"))).toEqual(result);
    expect(renderAnalysis(sampleResult(), "text")).not.toContain("baseline source:");
  });

  it("escapes source-path controls in finding context and keeps the rename summary capped", () => {
    const result = renamedResult("src/old\u001b[2J\n\u202e.ts");
    const text = renderAnalysis(result, "text");

    expect(text).toContain('(baseline source: "src/old\\u001b[2J\\n\\u202e.ts")');
    expect(text).not.toContain("\u001b");
    expect(text).not.toContain("\u202e");
    const many: WatcherlessAnalysisResult = {
      ...analyzeChangedFiles([]),
      baselineComparison: {
        ...result.baselineComparison!,
        renameSources: Array.from({ length: 23 }, (_, index) => ({
          path: `new-${index}.ts`,
          sourcePath: `old-${index}.ts`,
          suppressedExistingSecrets: 0,
        })),
      },
    };
    const summary = renderAnalysis(many, "text");
    expect(summary).toContain("Baseline rename sources: 23 file(s).");
    expect(summary).toContain("- new-19.ts <- old-19.ts: 0 suppressed.");
    expect(summary).not.toContain("old-20.ts");
  });

  it("describes coverage, truncating a long skipped list, and the allowlist count", () => {
    const skipped = Array.from({ length: 23 }, (_, index) => ({ path: `bin/file-${index}.dat`, reason: "binary" }));
    const result: WatcherlessAnalysisResult = {
      ...analyzeChangedFiles([]),
      coverage: { source: "index", scannedTextFiles: 4, skipped },
      secretAllowlist: { suppressedFindings: 2 },
    };
    const text = renderAnalysis(result, "text");

    expect(text).toContain("Content scanned: 4 index file(s).");
    expect(text).toContain("Content skipped: 23 file(s).");
    expect(text).toContain("- bin/file-19.dat: binary");
    expect(text).not.toContain("bin/file-20.dat");
    expect(text).toContain("- 3 additional skipped file(s) omitted from text output.");
    expect(text).toContain("Secret findings hidden by the configured allowlist: 2.");
  });

  it("renders baseline and policy sections only when they were computed", () => {
    const plain = renderAnalysis(analyzeChangedFiles([]), "text");
    expect(plain).not.toContain("Baseline commit");
    expect(plain).not.toContain("Policy ");
    expect(plain).not.toContain("allowlist");

    const result: WatcherlessAnalysisResult = {
      ...analyzeChangedFiles([]),
      baselineComparison: {
        commit: "a".repeat(40),
        suppressedExistingSecrets: 3,
        scannedTextFiles: 2,
        absentFiles: 1,
        skipped: [{ path: "big.bin", reason: "too large" }],
        renameSources: [{ path: "b.ts", sourcePath: "a.ts", suppressedExistingSecrets: 1 }],
      },
      policyEvaluation: {
        profile: "ci-review",
        failed: true,
        newSecretCount: 1,
        skippedStagedFiles: 2,
        skippedBaselineFiles: 1,
        severityRiskCount: 5,
      },
    };
    const text = renderAnalysis(result, "text");

    expect(text).toContain(`Baseline commit: ${"a".repeat(40)}`);
    expect(text).toContain("Existing secret findings suppressed: 3.");
    expect(text).toContain("- big.bin: too large");
    expect(text).toContain("- b.ts <- a.ts: 1 suppressed.");
    expect(text).toContain("Policy ci-review: failed.");
    expect(text).toContain("New secret findings: 1.");
    expect(text).toContain("Skipped staged content: 2 file(s).");
    expect(text).toContain("Risk findings matching the policy threshold/categories: 5.");
  });
});

describe("analysis SARIF", () => {
  it("adds the verified baseline source to matching results while retaining primary locations and run metadata", () => {
    const sourcePath = "src/old ü#1\u001b.ts";
    const result = renamedResult(sourcePath);
    const sarif = toAnalysisSarif(result) as {
      runs: Array<{
        properties: { analysisBaselineComparison: unknown };
        results: Array<{
          ruleId: string;
          locations: Array<{ physicalLocation: { artifactLocation: { uri: string }; region?: { startLine: number } } }>;
          properties?: { baselineSourcePath: string };
        }>;
      }>;
    };
    const run = sarif.runs[0];
    const secret = run.results.find((finding) => finding.ruleId === "possible-secret:Possible secret");

    expect(secret?.properties).toEqual({ baselineSourcePath: sourcePath });
    expect(secret?.locations).toEqual([
      {
        physicalLocation: { artifactLocation: { uri: "src/auth/renamed.ts" }, region: { startLine: 2 } },
      },
    ]);
    expect(run.results.find((finding) => finding.ruleId === "metadata-risk:Lockfile")).not.toHaveProperty("properties");
    expect(run.properties.analysisBaselineComparison).toEqual(result.baselineComparison);
    expect(JSON.stringify(sarif)).not.toContain("existing_test_credential");
    expect(JSON.stringify(sarif)).not.toContain("new_test_credential");
  });

  it("emits a SARIF 2.1.0 log with levels, rule ids, encoded locations and line regions", () => {
    const sarif = toAnalysisSarif(sampleResult()) as {
      version: string;
      $schema: string;
      runs: Array<{
        tool: { driver: { name: string; rules: Array<{ id: string }> } };
        results: Array<{
          ruleId: string;
          level: string;
          message: { text: string };
          locations: Array<{ physicalLocation: { artifactLocation: { uri: string }; region?: { startLine: number } } }>;
        }>;
        properties?: unknown;
      }>;
    };
    const [run] = sarif.runs;

    expect(sarif.version).toBe("2.1.0");
    expect(sarif.$schema).toBe("https://json.schemastore.org/sarif-2.1.0.json");
    expect(run.tool.driver.name).toBe("Agent Black Box");
    expect(run.properties).toBeUndefined();
    expect(run.results.every((finding) => !("properties" in finding))).toBe(true);
    expect(run.tool.driver.rules.map((rule) => rule.id).sort()).toEqual([
      "metadata-risk:Auth/security-related file",
      "metadata-risk:Lockfile",
      "possible-secret:Possible secret",
    ]);

    const secret = run.results.find((result) => result.ruleId === "possible-secret:Possible secret");
    expect(secret?.level).toBe("error");
    expect(secret?.locations[0].physicalLocation.region).toEqual({ startLine: 1 });
    expect(secret?.locations[0].physicalLocation.artifactLocation.uri).toBe("src/auth/session%20%C3%BC%231.ts");
    expect(run.results.find((result) => result.ruleId === "metadata-risk:Lockfile")?.level).toBe("warning");
    expect(
      run.results.find((result) => result.ruleId === "metadata-risk:Lockfile")?.locations[0].physicalLocation
    ).not.toHaveProperty("region");
    expect(JSON.stringify(sarif)).not.toContain("abcdef123456");
  });

  it("carries coverage, baseline, policy and allowlist details as run properties", () => {
    const base = analyzeChangedFiles([]);
    const sarif = toAnalysisSarif({
      ...base,
      coverage: { source: "worktree", scannedTextFiles: 1, skipped: [] },
      secretAllowlist: { suppressedFindings: 4 },
    }) as { runs: Array<{ properties: Record<string, unknown> }> };

    expect(Object.keys(sarif.runs[0].properties).sort()).toEqual(["analysisCoverage", "secretAllowlist"]);
    expect(sarif.runs[0].properties.secretAllowlist).toEqual({ suppressedFindings: 4 });
  });
});
