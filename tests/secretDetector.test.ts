import { writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/config/defaults.js";
import { detectPossibleSecrets, detectSecretsInLine, shannonEntropy } from "../src/risks/secretDetector.js";
import { createTempDir, removeTempDir } from "./testUtils.js";

describe("secret detector", () => {
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

      const findings = await detectPossibleSecrets(
        dir,
        [{ path: "settings.env", status: "added" }],
        DEFAULT_CONFIG
      );

      expect(findings.length).toBeGreaterThan(0);
      expect(JSON.stringify(findings)).not.toContain(fakeSecretValue);
    } finally {
      await removeTempDir(dir);
    }
  });
});
