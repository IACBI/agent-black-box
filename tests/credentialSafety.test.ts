import { evaluateSecretPatternRedaction } from "../src/risks/secretPatternEvaluator.js";
import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";
import { analyzeChangedFiles } from "../src/analyze/analyzer.js";
import { redactCommandParts } from "../src/commands/commandRecorder.js";
import {
  detectSecretsInLine,
  redactKnownSecretTokens,
  redactKnownSecretTokensWithRules,
} from "../src/risks/secretDetector.js";
import {
  compileSecretRules,
  matchCustomSecretPatterns,
  matchCustomSecretPatternsInLines,
  redactCustomSecretPatterns,
} from "../src/risks/secretRules.js";

describe("credential recognition and bounded redaction", () => {
  it.each(["'\"' + ", '"unfinished\\q '])(
    "recognises an escaped credential after unrelated quote prefix %#",
    (prefix) => {
      const content = prefix + '"\\u0041SIA' + "Q".repeat(16) + '"';
      expect(detectSecretsInLine("settings.ts", content, 1).length).toBeGreaterThan(0);
      expect(redactKnownSecretTokens(content)).toBe("<redacted>");
      expect(redactCommandParts(["echo", content])).toEqual(["echo", "<redacted>"]);
    }
  );

  it.each([
    '"\\u0067hp_' + "a1".repeat(15) + '"',
    '"\\u0041uthorization: Bearer synthetic-private-value"',
    '"https:\\u002f\\u002fapp:synthetic-password@example.test/main"',
    '"ghp_' + "b2".repeat(15) + " \\u0067hp_" + "a1".repeat(15) + '"',
    '"-----\\u0042EGIN PRIVATE KEY-----\\nsynthetic body\\n-----END PRIVATE KEY-----"',
  ])("recognises JSON-escaped credential form %# without retaining its encoded value", (encoded) => {
    const content = `{"value":${encoded}}`;
    expect(detectSecretsInLine("settings.json", content, 2).length).toBeGreaterThan(0);
    const analysis = analyzeChangedFiles([{ path: "settings.json", status: "modified", content }]);
    expect(analysis.findings.some((finding) => finding.kind === "possible-secret")).toBe(true);
    expect(JSON.stringify(analysis)).not.toContain(encoded);
    expect(redactKnownSecretTokens(content)).toBe("<redacted>");
    expect(redactCommandParts(["echo", content])).toEqual(["echo", "<redacted>"]);
    const rules = compileSecretRules({ secretPatterns: [{ name: "Context", pattern: "value" }] });
    expect(redactCommandParts(["echo", content], rules)).toEqual(["echo", "<redacted>"]);
  });

  it("keeps benign JSON escapes unchanged and recognises hidden credentials at the redaction input boundary", () => {
    const benign = JSON.stringify({ path: "C:\\project\\source", text: 'say "hello"' });
    expect(detectSecretsInLine("settings.json", benign, 1)).toEqual([]);
    expect(redactKnownSecretTokens(benign)).toBe(benign);
    const suffix = "\\u0067hp_" + "a1".repeat(15) + '"';
    const encoded = '"' + " ".repeat(65_536 - suffix.length - 1) + suffix;
    expect(encoded).toHaveLength(65_536);
    expect(detectSecretsInLine("settings.json", encoded, 1).length).toBeGreaterThan(0);
    expect(redactKnownSecretTokens(encoded)).toBe("<redacted>");
    expect(redactKnownSecretTokens(encoded + " ")).toBe("<redacted>");
  });

  const credentials = [
    "ASIA" + "Q".repeat(16),
    "github_pat_" + "a1".repeat(41),
    "glpat-" + "a1".repeat(10),
    "npm_" + "a1".repeat(18),
    "pypi-" + "a1".repeat(30),
    "Authorization: Basic " + Buffer.from("user:synthetic-password").toString("base64"),
    "Proxy-Authorization: Bearer synthetic-private-value",
    "postgres://app:synthetic-password@db.example.test/main",
    "https://synthetic-password@example.test/main",
  ];

  it.each(credentials)("detects and redacts credential form %# using the same rules", (credential) => {
    const findings = detectSecretsInLine("settings.txt", credential, 7);
    expect(findings.length).toBeGreaterThan(0);
    expect(findings.every((finding) => finding.line === 7 && finding.redacted === "<redacted>")).toBe(true);
    expect(JSON.stringify(findings)).not.toContain(credential);
    const analysis = analyzeChangedFiles([{ path: "settings.txt", status: "modified", content: credential }]);
    expect(analysis.findings.some((finding) => finding.kind === "possible-secret")).toBe(true);
    expect(JSON.stringify(analysis)).not.toContain(credential);
    const redacted = redactKnownSecretTokens(credential);
    expect(redacted).toContain("<redacted>");
    expect(redacted).not.toContain(credential);
    expect(redactCommandParts(["echo", credential]).join(" ")).not.toContain(credential);
  });

  it.each(credentials)("composes custom context around every built-in credential family %#", (credential) => {
    const escaped = credential.replace(/[.*+?^${}()|[\]\\]/g, (match) => "\\" + match);
    const value = "begin " + credential + " !private-tail";
    const rules = compileSecretRules({
      secretPatterns: [{ name: "Wrapped credential", pattern: "begin " + escaped + " !private-tail" }],
    });
    expect(redactKnownSecretTokensWithRules(value, rules, new Uint32Array(value.length))).toEqual({
      text: "<redacted>",
      customMatched: true,
    });
    expect(redactCommandParts(["echo", value], rules)).toEqual(["echo", "<redacted>"]);
  });

  it.each([
    ["Authorization", "Authorization: Bearer synthetic-private-value", "<redacted>: <redacted>"],
    ["https://", "https://synthetic-private-value@example.test/path", "<redacted><redacted>@example.test/path"],
    ["BEGIN", "-----BEGIN PRIVATE KEY-----\nsynthetic-private-value\n-----END PRIVATE KEY-----", "<redacted>"],
    ["eyJ", "eyJ" + "a".repeat(12) + "." + "b".repeat(12) + "." + "c".repeat(12), "<redacted>"],
  ])(
    "keeps complete built-in masking when custom pattern %s matches only part of its context",
    (pattern, value, expected) => {
      const rules = compileSecretRules({ secretPatterns: [{ name: "Partial context", pattern }] });
      expect(redactKnownSecretTokensWithRules(value!, rules, new Uint32Array(value!.length))).toEqual({
        text: expected,
        customMatched: true,
      });
    }
  );

  it("retains precise masking at the composition input limit", () => {
    const value = "corp_abcdef012345";
    const padding = "x".repeat(65_536 - value.length);
    const text = padding + value;
    const rules = compileSecretRules({ secretPatterns: [{ name: "Internal", pattern: "corp_[a-z0-9]{12}" }] });
    expect(redactKnownSecretTokensWithRules(text, rules, new Uint32Array(text.length))).toEqual({
      text: padding + "<redacted>",
      customMatched: true,
    });
  });

  it("fails closed for oversized composition inputs or invalid original-text masks", () => {
    const rules = compileSecretRules({ secretPatterns: [{ name: "Internal", pattern: "corp_[a-z0-9]{12}" }] });
    const oversized = "x".repeat(65_537);
    expect(redactKnownSecretTokensWithRules(oversized, rules, new Uint32Array(0))).toEqual({
      text: "<redacted>",
      customMatched: true,
    });
    for (const mask of [new Uint32Array(1), new Uint32Array([0, 1]), new Uint32Array([3, 0])]) {
      const invalidRules = compileSecretRules({ secretPatterns: [{ name: "Internal", pattern: "corp_[a-z0-9]{12}" }] });
      expect(evaluateSecretPatternRedaction(invalidRules, "xx", mask)).toEqual({
        text: "<redacted>",
        customMatched: true,
      });
      expect(() => matchCustomSecretPatterns(invalidRules, "ordinary")).toThrow("resource limit");
    }
  });

  it("finds escaped JSON assignment names and credentials inside script URLs without exposing them", () => {
    const escaped = '{"pass\\u0077ord":"synthetic-private-value"}';
    expect(
      detectSecretsInLine("settings.json", escaped, 1).some(
        (finding) => finding.reason === "Possible Secret assignment-like value detected."
      )
    ).toBe(true);
    expect(redactKnownSecretTokens(escaped)).toBe("<redacted>");
    expect(analyzeChangedFiles([{ path: "settings.json", status: "modified", content: escaped }]).findings).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "possible-secret", line: 1 })])
    );
    expect(
      redactCommandParts(["sh", "-c", "connect postgres://user:synthetic-private-value@db/main"])[2]
    ).not.toContain("synthetic-private-value");
    const malformed = '{"pass\\u0077ord\n":"ordinary value"}';
    expect(detectSecretsInLine("settings.json", malformed, 1)).toEqual([]);
    expect(redactKnownSecretTokens(malformed)).toBe(malformed);
    const privateKey = "-----BEGIN PRIVATE KEY-----\nsynthetic-private-value\n-----END PRIVATE KEY-----";
    expect(redactKnownSecretTokens(privateKey)).toBe("<redacted>");
  });

  it("handles repeated JWT and LLM prefixes without quadratic regex retries", () => {
    const jwt = "eyJ" + "a".repeat(12) + "." + "b".repeat(12) + "." + "c".repeat(12);
    const text = "eyJ".repeat(20_000) + "!" + jwt;
    const start = performance.now();
    expect(redactKnownSecretTokens(text)).toBe("eyJ".repeat(20_000) + "!<redacted>");
    expect(redactKnownSecretTokens("sk-".repeat(20_000))).not.toContain("<redacted>");
    expect(performance.now() - start).toBeLessThan(2000);
    expect(redactKnownSecretTokens("a".repeat(65_537))).toBe("<redacted>");
    expect(redactCommandParts(["echo", "a".repeat(1_000_000)])[1]).toBe("<redacted>");
  });

  it("preserves overlapping JWT detection and redacts complete merged spans", () => {
    const component = "eyJ" + "a".repeat(12);
    const jwt = [component, component, component, component].join(".");
    expect(redactKnownSecretTokens(jwt)).toBe("<redacted>");
  });

  it("terminates custom regex backtracking missed by the screen, fails scanning explicitly, and redacts closed", () => {
    // Alternation has no nested quantifier, but failed matches can backtrack exponentially.
    const rules = compileSecretRules({ secretPatterns: [{ name: "Expensive", pattern: "(a|aa)+b" }] });
    const start = performance.now();
    expect(() => matchCustomSecretPatterns(rules, "a".repeat(4096) + "!")).toThrow("resource limit");
    expect(performance.now() - start).toBeLessThan(7000);
    expect(redactCustomSecretPatterns(rules, "private content")).toBe("<redacted>");
    const redactionRules = compileSecretRules({ secretPatterns: [{ name: "Expensive", pattern: "(a|aa)+b" }] });
    expect(redactCustomSecretPatterns(redactionRules, "a".repeat(4096) + "!")).toBe("<redacted>");
    const ordinary = compileSecretRules({ secretPatterns: [{ name: "Ordinary", pattern: "corp_[a-z0-9]{12}" }] });
    expect(matchCustomSecretPatterns(ordinary, "corp_abcdef012345")).toEqual(["Ordinary"]);
    expect(redactCustomSecretPatterns(ordinary, "corp_abcdef012345")).toBe("<redacted>");
    expect(redactCustomSecretPatterns(ordinary, "x".repeat(65_537))).toBe("<redacted>");
  }, 20_000);

  it("rejects an entire batch if any custom-pattern line exceeds the strict execution deadline", () => {
    const rules = compileSecretRules({ secretPatterns: [{ name: "Expensive", pattern: "(a|aa)+b" }] });
    expect(() => matchCustomSecretPatternsInLines(rules, ["ordinary", "a".repeat(4096)])).toThrow("resource limit");
    expect(() => matchCustomSecretPatternsInLines(rules, ["ordinary"])).toThrow("resource limit");
    expect(redactCustomSecretPatterns(rules, "private content")).toBe("<redacted>");
    const ordinary = compileSecretRules({ secretPatterns: [{ name: "Ordinary", pattern: "corp_[a-z0-9]{12}" }] });
    expect(matchCustomSecretPatternsInLines(ordinary, ["corp_abcdef012345"])).toEqual([["Ordinary"]]);
  }, 20_000);

  it("bounds regex output expansion instead of exhausting memory", () => {
    const rules = compileSecretRules({ secretPatterns: [{ name: "Every character", pattern: "a" }] });
    expect(redactCustomSecretPatterns(rules, "a".repeat(65_536))).toBe("<redacted>");
  });
});
