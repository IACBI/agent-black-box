import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/config/defaults.js";
import { detectPossibleSecrets, detectSecretsInLine, shannonEntropy } from "../src/risks/secretDetector.js";
import { createTempDir, removeTempDir } from "./testUtils.js";

describe("secret detector", () => {
  it.each([
    ["AWS access key-like value", `AKIA${"A".repeat(16)}`],
    ["GitHub token-like value", `ghp_${"a".repeat(20)}`],
    ["Slack token-like value", `xoxb-${"a".repeat(20)}`],
    ["JWT-like value", `eyJ${"a".repeat(10)}.${"b".repeat(10)}.${"c".repeat(10)}`],
    ["Secret assignment-like value", `password=${"a".repeat(12)}`],
  ])("detects %s consistently across consecutive lines without exposing content", (name, line) => {
    for (const lineNumber of [1, 2]) {
      const findings = detectSecretsInLine("settings.txt", line, lineNumber);
      expect(findings).toEqual([
        {
          path: "settings.txt",
          line: lineNumber,
          reason: `Possible ${name} detected.`,
          redacted: "<redacted>",
        },
      ]);
      expect(JSON.stringify(findings)).not.toContain(line);
    }
  });

  it("enforces byte limits and path boundaries while preserving line numbers and deduplicating", async () => {
    const dir = await createTempDir();
    try {
      const repoRoot = path.join(dir, "repo");
      await mkdir(repoRoot);
      const assignment = `password=${"a".repeat(12)}`;
      const content = `heading\r\n${assignment}\r\n`;
      await Promise.all([
        writeFile(path.join(repoRoot, "boundary.txt"), content.padEnd(1024, " "), "utf8"),
        writeFile(path.join(repoRoot, "oversized.txt"), content.padEnd(1025, " "), "utf8"),
        writeFile(path.join(repoRoot, "binary.dat"), `\0${assignment}`, "utf8"),
        writeFile(path.join(repoRoot, "deleted.txt"), assignment, "utf8"),
        writeFile(path.join(dir, "outside.txt"), assignment, "utf8"),
      ]);

      const findings = await detectPossibleSecrets(
        repoRoot,
        [
          { path: "boundary.txt", status: "added" },
          { path: "boundary.txt", status: "modified" },
          { path: "oversized.txt", status: "added" },
          { path: "binary.dat", status: "added" },
          { path: "deleted.txt", status: "deleted" },
          { path: "missing.txt", status: "modified" },
          { path: "../outside.txt", status: "added" },
          { path: path.join(dir, "outside.txt"), status: "added" },
        ],
        { ...DEFAULT_CONFIG, maxFileSizeKb: 1 }
      );

      expect(findings).toEqual([
        {
          path: "boundary.txt",
          line: 2,
          reason: "Possible Secret assignment-like value detected.",
          redacted: "<redacted>",
        },
      ]);
    } finally {
      await removeTempDir(dir);
    }
  });

  it("preserves the previous JWT detection rules at component boundaries", () => {
    const previousPattern = /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/;
    const headers = ["", "eyJ", `eyJ${"a".repeat(9)}`, `eyJ${"a".repeat(10)}`, `prefixeyJ${"_-".repeat(10)}`];

    for (const header of headers) {
      for (const payloadLength of [9, 10, 20]) {
        for (const signatureLength of [9, 10, 20]) {
          for (const firstSeparator of [".", "..", ". ", "/", ""]) {
            for (const secondSeparator of [".", "..", ". ", "/", ""]) {
              const line = `${header}${firstSeparator}${"b".repeat(payloadLength)}${secondSeparator}${"c".repeat(signatureLength)}`;
              const detected = detectSecretsInLine("settings.txt", line, 1).some(
                (finding) => finding.reason === "Possible JWT-like value detected."
              );
              expect(detected, line).toBe(previousPattern.test(line));
            }
          }
        }
      }
    }
  });

  it("handles long repeated JWT prefixes and still finds a later valid value", () => {
    const prefixes = "eyJ".repeat(40_000);
    expect(detectSecretsInLine("settings.txt", prefixes, 1)).toEqual([]);

    const validValue = `eyJ${"a".repeat(10)}.${"b".repeat(10)}.${"c".repeat(10)}`;
    expect(detectSecretsInLine("settings.txt", `${prefixes}!${validValue}`, 2)).toEqual([
      {
        path: "settings.txt",
        line: 2,
        reason: "Possible JWT-like value detected.",
        redacted: "<redacted>",
      },
    ]);
  });

  it("detects secret assignment-like values without exposing the value", () => {
    const fakeSecretValue = ["abcdefgh", "ijklmnop", "qrstuvwx", "yz123456"].join("");
    const findings = detectSecretsInLine("src/config.ts", `API_TOKEN=${fakeSecretValue}`, 3);

    expect(findings.length).toBeGreaterThan(0);
    expect(findings[0]?.redacted).toBe("<redacted>");
    expect(JSON.stringify(findings)).not.toContain(fakeSecretValue);
  });

  it("uses entropy as a signal near sensitive keywords", () => {
    expect(shannonEntropy("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")).toBeLessThan(1);
    expect(shannonEntropy("aZ9qL2xP8vN4mR7sT1uY6wE3bC5dF0hJ")).toBeGreaterThan(4);
  });

  it("calculates entropy consistently for Unicode code points", () => {
    expect(shannonEntropy("")).toBe(0);
    expect(shannonEntropy("\u{1F600}".repeat(4))).toBe(0);
    expect(shannonEntropy("a\u{1F600}a\u{1F600}")).toBe(1);
  });

  it("does not treat code identifier chains as high-entropy values", () => {
    const findings = detectSecretsInLine(
      "src/reports/markdown.ts",
      "- Possible secrets: ${report.riskSummary.possibleSecretCount}",
      263
    );

    expect(findings).toEqual([]);
  });

  it("scans changed files up to configured size", async () => {
    const dir = await createTempDir();
    try {
      const fakeSecretValue = ["aZ9qL2xP", "8vN4mR7s", "T1uY6wE3", "bC5dF0hJ"].join("");
      await writeFile(path.join(dir, "settings.env"), `client_secret=${fakeSecretValue}\n`, "utf8");

      const findings = await detectPossibleSecrets(dir, [{ path: "settings.env", status: "added" }], DEFAULT_CONFIG);

      expect(findings.length).toBeGreaterThan(0);
      expect(JSON.stringify(findings)).not.toContain(fakeSecretValue);
    } finally {
      await removeTempDir(dir);
    }
  });
});
