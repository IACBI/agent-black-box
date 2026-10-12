import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/config/defaults.js";
import {
  detectPossibleSecrets,
  detectSecretsInLine,
  redactKnownSecretTokens,
  scanChangedFilesForSecrets,
  scanSecretsInLine,
} from "../src/risks/secretDetector.js";
import { compileSecretRules } from "../src/risks/secretRules.js";
import type { AgentBlackBoxConfig } from "../src/types.js";
import { createTempDir, removeTempDir } from "./testUtils.js";

const customRules = compileSecretRules({
  secretPatterns: [{ name: "Internal service token", pattern: "corp_[a-z0-9]{16}" }],
  secretAllowlist: [
    { path: "tests/fixtures", reason: "synthetic credentials used by the test-suite" },
    { contains: "corp_exampleexample00", reason: "documented placeholder" },
  ],
});

describe("provider token shapes", () => {
  it.each([
    ["LLM API key-like value", `sk-ant-api03-${"aB3".repeat(14)}`],
    ["LLM API key-like value", `sk-proj-${"x9".repeat(20)}`],
    ["Stripe live key-like value", `sk_live_${"a1".repeat(12)}`],
    ["Stripe live key-like value", `rk_live_${"Z9".repeat(12)}`],
    ["Google API key-like value", `AIza${"Sy-_0".repeat(7)}`],
    ["Private key block", "-----BEGIN OPENSSH PRIVATE KEY-----"],
  ])("detects %s", (name, value) => {
    const findings = detectSecretsInLine("config.txt", `value = ${value}`, 3);
    expect(findings.map((finding) => finding.reason)).toContain(`Possible ${name} detected.`);
    expect(JSON.stringify(findings)).not.toContain(value);
  });

  it.each([
    "sk-learn-feature-extraction-pipeline-configuration-name",
    "task-0123456789abcdef0123456789abcdef0123",
    `sk_test_${"a1".repeat(12)}`,
    "AIza-too-short",
    "-----BEGIN PUBLIC KEY-----",
  ])("does not flag look-alike text: %s", (value) => {
    expect(detectSecretsInLine("config.txt", `value = ${value}`, 1)).toEqual([]);
  });

  it("redacts provider tokens wherever they appear in text and leaves the rest alone", () => {
    const github = `ghp_${"a".repeat(24)}`;
    const aws = `AKIA${"B".repeat(16)}`;
    const jwt = `eyJ${"a".repeat(12)}.${"b".repeat(12)}.${"c".repeat(12)}`;
    const text = `echo ${github} && curl -H "x: ${jwt}" --data ${aws} src/index.ts`;

    expect(redactKnownSecretTokens(text)).toBe(
      'echo <redacted> && curl -H "x: <redacted>" --data <redacted> src/index.ts'
    );
    expect(redactKnownSecretTokens("nothing sensitive: ghp_short AKIA123")).toBe(
      "nothing sensitive: ghp_short AKIA123"
    );
  });
});

describe("custom secret patterns and the allowlist", () => {
  it("reports a configured pattern under its own name without echoing the match", () => {
    const value = "corp_0123456789abcdef";
    const scan = scanSecretsInLine("src/client.ts", `const token = "${value}"`, 7, customRules);

    expect(scan.allowlisted).toBe(0);
    expect(scan.findings).toContainEqual({
      path: "src/client.ts",
      line: 7,
      reason: "Possible Internal service token detected.",
      redacted: "<redacted>",
    });
    expect(JSON.stringify(scan)).not.toContain(value);
  });

  it("finds nothing extra when no rules are supplied", () => {
    expect(detectSecretsInLine("src/client.ts", "id corp_0123456789abcdef", 1)).toEqual([]);
  });

  it("suppresses and counts every finding on an allowlisted line, whichever rule produced it", () => {
    const line = "password = corp_exampleexample00 # AKIAIOSFODNN7EXAMPLE";
    const scan = scanSecretsInLine("src/client.ts", line, 1, customRules);

    expect(scan.findings).toEqual([]);
    expect(scan.allowlisted).toBeGreaterThanOrEqual(2);
    expect(detectSecretsInLine("tests/fixtures/a.env", "TOKEN=abcdefghijklmnop", 1, customRules)).toEqual([]);
    expect(detectSecretsInLine("src/a.env", "TOKEN=abcdefghijklmnop", 1, customRules)).toHaveLength(1);
  });

  it("never suppresses a line that is not covered, even next to an allowlisted one", () => {
    const lines = ["ok corp_exampleexample00", "bad corp_0123456789abcdef"];
    const results = lines.map((line, index) => scanSecretsInLine("src/a.ts", line, index + 1, customRules));

    expect(results[0]).toMatchObject({ findings: [], allowlisted: 1 });
    expect(results[1].findings).toHaveLength(1);
    expect(results[1].allowlisted).toBe(0);
  });

  it("scans changed files with the configured rules and reports how many findings the allowlist hid", async () => {
    const repo = await createTempDir("abb-secret-rules-");
    try {
      await mkdir(path.join(repo, "tests", "fixtures"), { recursive: true });
      await mkdir(path.join(repo, "src"));
      await writeFile(
        path.join(repo, "tests", "fixtures", "seed.env"),
        "TOKEN=abcdefghijklmnop\nB=corp_0123456789abcdef\n"
      );
      await writeFile(path.join(repo, "src", "client.ts"), "const a = 1;\nconst t = 'corp_0123456789abcdef';\n");
      const config: AgentBlackBoxConfig = {
        ...DEFAULT_CONFIG,
        secretPatterns: [{ name: "Internal service token", pattern: "corp_[a-z0-9]{16}" }],
        secretAllowlist: [{ path: "tests/fixtures", reason: "synthetic credentials" }],
      };
      const changed = [
        { path: "tests/fixtures/seed.env", status: "added" as const },
        { path: "src/client.ts", status: "added" as const },
        { path: "src/gone.ts", status: "deleted" as const },
      ];

      const scan = await scanChangedFilesForSecrets(repo, changed, config);
      expect(scan.findings).toEqual([
        {
          path: "src/client.ts",
          line: 2,
          reason: "Possible Internal service token detected.",
          redacted: "<redacted>",
        },
      ]);
      expect(scan.allowlisted).toBe(2);
      expect(await detectPossibleSecrets(repo, changed, config)).toEqual(scan.findings);

      const withoutRules = await scanChangedFilesForSecrets(repo, changed, DEFAULT_CONFIG);
      expect(withoutRules.allowlisted).toBe(0);
      expect(withoutRules.findings.map((finding) => finding.path)).toContain("tests/fixtures/seed.env");
    } finally {
      await removeTempDir(repo);
    }
  });

  it("refuses to scan with an invalid rule set rather than silently scanning without it", async () => {
    const config: AgentBlackBoxConfig = { ...DEFAULT_CONFIG, secretPatterns: [{ name: "x", pattern: "(a+)+" }] };
    await expect(scanChangedFilesForSecrets(process.cwd(), [], config)).rejects.toThrow("Invalid secret rules");
  });
});
