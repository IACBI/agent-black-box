import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { analyzeChangedFiles } from "../src/analyze/analyzer.js";
import { compileSecretRules } from "../src/risks/secretRules.js";

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

  it("flags a PGP private key block header", () => {
    const result = analyzeChangedFiles([
      { path: "key.asc", status: "added", kind: "text", content: "-----BEGIN PGP PRIVATE KEY BLOCK-----" },
    ]);

    expect(result.findings.map((finding) => finding.category)).toContain("Possible secret");
  });

  it("does not flag identifiers that merely contain sk- or auth as text", () => {
    const result = analyzeChangedFiles([
      {
        path: "src/meta.ts",
        status: "modified",
        kind: "text",
        content: [
          '"flask-sqlalchemy-migrations": "1.0.0"',
          'const author = "Jonathan";',
          'const authority = "Jonathan";',
        ].join("\n"),
      },
    ]);

    expect(result.findings.filter((finding) => finding.category === "Possible secret")).toEqual([]);
  });

  it("keeps every finding from a single bounded file with many matching lines", () => {
    const lineCount = 125_000;
    const content = "x\n".repeat(lineCount);
    const secretRules = compileSecretRules({ secretPatterns: [{ name: "Marker", pattern: "^x$" }] });
    const result = analyzeChangedFiles([{ path: "marker.txt", status: "modified", kind: "text", content }], {
      secretRules,
    });

    expect(Buffer.byteLength(content)).toBeLessThan(256 * 1024);
    expect(result.findings).toHaveLength(lineCount);
    expect(result.findings.every((finding, index) => finding.line === index + 1)).toBe(true);
    expect(result.findings[0]).toEqual(
      expect.objectContaining({ path: "marker.txt", line: 1, kind: "possible-secret", severity: "high" })
    );
    expect(result.findings.at(-1)).toEqual(expect.objectContaining({ path: "marker.txt", line: lineCount }));
    expect(result.summary).toEqual({
      findingCount: lineCount,
      maxSeverity: "high",
      score: 90,
      severityCounts: { low: 0, medium: 0, high: lineCount },
    });
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

describe("analysis filename semantics", () => {
  it.each([
    { name: "POSIX", implementation: path.posix, expectedPath: "src\\client.ts" },
    { name: "Windows", implementation: path.win32, expectedPath: "src/client.ts" },
  ])("uses $name path separators without accepting unsafe metadata", async ({ implementation, expectedPath }) => {
    vi.resetModules();
    vi.doMock("node:path", () => ({ default: implementation }));
    try {
      const { analyzeChangedFiles: analyze } = await import("../src/analyze/analyzer.js");
      const result = analyze([
        { path: "src\\client.ts", status: "modified", content: "PASSWORD=synthetic_credential" },
      ]);
      expect(result.findings).toMatchObject([{ path: expectedPath, kind: "possible-secret" }]);
      for (const unsafe of ["../outside.ts", "src//client.ts", "src/./client.ts", "src/../client.ts", "/outside.ts"]) {
        expect(analyze([{ path: unsafe, status: "modified" }]).findings).toMatchObject([
          { path: "[invalid path]", category: "Invalid change metadata" },
        ]);
      }
    } finally {
      vi.doUnmock("node:path");
      vi.resetModules();
    }
  });

  it("keeps POSIX backslash filenames distinct when comparing unchanged baseline credentials", async () => {
    vi.resetModules();
    vi.doMock("node:path", () => ({ default: path.posix }));
    try {
      const { analyzeChangedFiles: analyze } = await import("../src/analyze/analyzer.js");
      const { compareAnalysisWithBaseline: compare } = await import("../src/analyze/baseline.js");
      const literalPath = "a\\b.ts";
      const staged = [
        {
          path: literalPath,
          status: "modified" as const,
          kind: "text" as const,
          content: "PASSWORD=synthetic_new_credential",
        },
        {
          path: "a/b.ts",
          status: "modified" as const,
          kind: "text" as const,
          content: "PASSWORD=synthetic_old_credential",
        },
      ];
      const baseline = [{ ...staged[0], content: "ordinary" }, staged[1]];
      const current = analyze(staged);
      expect(current.findings.map((finding) => finding.path)).toEqual(["a/b.ts", literalPath]);
      const compared = compare(staged, baseline, current, "a".repeat(40));
      expect(compared.baselineComparison?.suppressedExistingSecrets).toBe(1);
      expect(compared.findings).toMatchObject([{ path: literalPath, line: 1, kind: "possible-secret" }]);
    } finally {
      vi.doUnmock("node:path");
      vi.resetModules();
    }
  });
});
