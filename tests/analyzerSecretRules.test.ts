import { describe, expect, it } from "vitest";
import { analyzeChangedFiles, type AnalysisInputFile } from "../src/analyze/analyzer.js";
import { compareAnalysisWithBaseline } from "../src/analyze/baseline.js";
import { compileSecretRules } from "../src/risks/secretRules.js";

const rules = compileSecretRules({
  secretPatterns: [{ name: "Internal service token", pattern: "corp_[a-z0-9]{16}" }],
  secretAllowlist: [
    { path: "tests/fixtures", reason: "synthetic credentials" },
    { contains: "corp_exampleexample00", reason: "documented placeholder" },
  ],
});

function textFile(filePath: string, content: string): AnalysisInputFile {
  return { path: filePath, status: "modified", kind: "text", content };
}

describe("watcherless analysis with custom secret rules", () => {
  it("flags a configured pattern as a possible secret without exposing the value", () => {
    const value = "corp_0123456789abcdef";
    const result = analyzeChangedFiles([textFile("src/client.ts", `a\nconst id = "${value}";\n`)], {
      secretRules: rules,
    });

    expect(result.findings).toContainEqual(
      expect.objectContaining({ path: "src/client.ts", line: 2, kind: "possible-secret", severity: "high" })
    );
    expect(JSON.stringify(result)).not.toContain(value);
    expect(result.secretAllowlist).toEqual({ suppressedFindings: 0 });
  });

  it("does not know the pattern unless it is supplied", () => {
    const result = analyzeChangedFiles([textFile("src/client.ts", "const id = 'corp_0123456789abcdef';")]);

    expect(result.findings).toEqual([]);
    expect(result).not.toHaveProperty("secretAllowlist");
  });

  it("hides allowlisted findings but counts them, and leaves metadata risks untouched", () => {
    const result = analyzeChangedFiles(
      [
        textFile("tests/fixtures/auth/seed.env", "API_KEY=abcdefghijklmnop\nPASSWORD=hunter2hunter2\n"),
        textFile("src/docs.ts", "// corp_exampleexample00 is the documented placeholder"),
        textFile("src/real.ts", "const t = 'corp_0123456789abcdef';"),
      ],
      { secretRules: rules }
    );

    expect(result.findings.filter((finding) => finding.kind === "possible-secret").map((f) => f.path)).toEqual([
      "src/real.ts",
    ]);
    expect(result.findings.some((finding) => finding.kind === "metadata-risk")).toBe(true);
    expect(result.secretAllowlist).toEqual({ suppressedFindings: 3 });
    expect(result.summary.findingCount).toBe(result.findings.length);
  });

  it("applies the same rules to the baseline side, so an existing custom-pattern line is not reported as new", () => {
    const line = "const id = 'corp_0123456789abcdef';";
    const staged = [textFile("src/client.ts", `// edited\n${line}\n`)];
    const baseline = [textFile("src/client.ts", `${line}\n`)];
    const options = { secretRules: rules };
    const current = analyzeChangedFiles(staged, options);
    expect(current.findings.filter((finding) => finding.kind === "possible-secret")).toHaveLength(1);

    const compared = compareAnalysisWithBaseline(staged, baseline, current, "a".repeat(40), options);
    expect(compared.findings.filter((finding) => finding.kind === "possible-secret")).toEqual([]);
    expect(compared.baselineComparison?.suppressedExistingSecrets).toBe(1);

    const withoutRules = compareAnalysisWithBaseline(staged, baseline, current, "a".repeat(40));
    expect(withoutRules.findings.filter((finding) => finding.kind === "possible-secret")).toHaveLength(1);
  });

  it("reports bounded custom-pattern coverage even when no credential is found or an allowlist applies", () => {
    const value = "corp_0123456789abcdef";
    const content = "x".repeat(4096) + value;
    for (const filePath of ["src/client.ts", "tests/fixtures/client.ts"]) {
      const result = analyzeChangedFiles([textFile(filePath, content)], { secretRules: rules });
      expect(result.findings).toEqual([
        expect.objectContaining({
          path: filePath,
          kind: "analysis-limit",
          category: "Custom secret pattern analysis limit",
        }),
      ]);
      expect(JSON.stringify(result)).not.toContain(value);
    }
    expect(analyzeChangedFiles([textFile("src/client.ts", content)]).findings).toEqual([]);
    expect(analyzeChangedFiles([textFile("src/client.ts", "x".repeat(4096))], { secretRules: rules }).findings).toEqual(
      []
    );
  });

  it("keeps the allowlist count when a baseline comparison is layered on top", () => {
    const staged = [textFile("tests/fixtures/seed.env", "PASSWORD=hunter2hunter2\n")];
    const options = { secretRules: rules };
    const current = analyzeChangedFiles(staged, options);
    const compared = compareAnalysisWithBaseline(staged, [], current, "b".repeat(40), options);

    expect(compared.secretAllowlist).toEqual({ suppressedFindings: 1 });
    expect(compared.findings).toEqual([]);
  });
});
