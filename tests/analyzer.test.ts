import { describe, expect, it } from "vitest";
import { analyzeChangedFiles } from "../src/analyze/analyzer.js";

describe("watcherless analysis core", () => {
  it("returns deterministically ordered metadata findings", () => {
    const result = analyzeChangedFiles([
      { path: "src/auth/session.ts", status: "modified" },
      { path: "pnpm-lock.yaml", status: "modified" },
      { path: ".github/workflows/ci.yml", status: "modified" },
    ]);

    expect(result.findings.map((finding) => `${finding.path}:${finding.category}`)).toEqual([
      ".github/workflows/ci.yml:CI/CD file",
      "pnpm-lock.yaml:Lockfile",
      "src/auth/session.ts:Auth/security-related file",
    ]);
    expect(result.summary).toEqual({
      findingCount: 3,
      maxSeverity: "high",
      score: 90,
      severityCounts: { low: 0, medium: 2, high: 1 },
    });
  });

  it("detects possible credential material without exposing its value", () => {
    const rawValue = "test_credential_value_987654321";
    const result = analyzeChangedFiles([
      {
        path: "src/config.ts",
        status: "modified",
        kind: "text",
        content: `const apiKey = "${rawValue}";`,
      },
    ]);

    expect(result.findings).toContainEqual(
      expect.objectContaining({
        path: "src/config.ts",
        line: 1,
        category: "Possible secret",
        severity: "high",
      })
    );
    expect(JSON.stringify(result)).not.toContain(rawValue);
  });

  it("does not report environment-variable references as hard-coded credentials", () => {
    const result = analyzeChangedFiles([
      {
        path: "src/config.ts",
        status: "modified",
        kind: "text",
        content: "const apiKey = process.env.API_KEY;",
      },
    ]);

    expect(result.findings.some((finding) => finding.category === "Possible secret")).toBe(false);
  });

  it("inspects later assignments on a line after ordinary settings or environment references", () => {
    const rawValue = "test_credential_value_987654321";
    const result = analyzeChangedFiles([
      {
        path: "src/settings.ts",
        status: "modified",
        content: [
          `const port = 8080; const password = "${rawValue}";`,
          `{"url": "https://example.invalid", "clientSecret": "${rawValue}"}`,
          `const apiKey = process.env.API_KEY; const password = "${rawValue}";`,
        ].join("\n"),
      },
    ]);

    expect(
      result.findings.filter((finding) => finding.kind === "possible-secret").map((finding) => finding.line)
    ).toEqual([1, 2, 3]);
    expect(JSON.stringify(result)).not.toContain(rawValue);
  });

  it("rejects unsafe paths without reflecting them in output", () => {
    const unsafePath = "../outside/credential-value";
    const result = analyzeChangedFiles([{ path: unsafePath, status: "added" }]);

    expect(result.findings).toEqual([
      expect.objectContaining({
        path: "[invalid path]",
        severity: "high",
        category: "Invalid change metadata",
      }),
    ]);
    expect(JSON.stringify(result)).not.toContain(unsafePath);
  });

  it("skips deleted and binary content while reporting a bounded analysis limit", () => {
    const result = analyzeChangedFiles(
      [
        {
          path: "deleted.env",
          status: "deleted",
          content: "password = definitely-not-reported",
        },
        {
          path: "image.bin",
          status: "modified",
          kind: "binary",
          content: "password = definitely-not-reported",
        },
        {
          path: "config.ts",
          status: "modified",
          content: "a very long file",
        },
      ],
      { maxContentCharacters: 4 }
    );

    expect(result.findings).toContainEqual(
      expect.objectContaining({
        path: "config.ts",
        category: "Content analysis limit",
        severity: "low",
      })
    );
    expect(result.findings.some((finding) => finding.category === "Possible secret")).toBe(false);
  });
});
