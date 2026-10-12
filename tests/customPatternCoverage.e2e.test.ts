import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/config/defaults.js";
import { runCli } from "./cliRunner.js";
import { createTempDir, initGitRepo, removeTempDir } from "./testUtils.js";

describe("custom-pattern coverage CLI", () => {
  it("reports partial staged and baseline scans and fails complete review without leaking skipped tokens", async () => {
    const repo = await createTempDir("abb-cli-custom-pattern-limits-");
    const token = "corp_abcdef012345";
    try {
      initGitRepo(repo);
      await writeFile(
        path.join(repo, ".agentblackbox.json"),
        JSON.stringify({
          ...DEFAULT_CONFIG,
          secretPatterns: [{ name: "Internal", pattern: "corp_[a-z0-9]{12}" }],
        })
      );
      await writeFile(path.join(repo, "client.txt"), "x".repeat(4096) + token);
      execFileSync("git", ["add", "client.txt"], { cwd: repo });
      const args = ["analyze", "--staged", "--initial", "--policy", "complete-review", "--format", "json"];
      const partial = await runCli(repo, args);
      expect(partial.exitCode, partial.stderr).toBe(1);
      const result = JSON.parse(partial.stdout);
      expect(result.coverage).toMatchObject({
        scannedTextFiles: 1,
        skipped: [],
        limited: [{ path: "client.txt", truncatedLines: 1 }],
      });
      expect(result.policyEvaluation).toMatchObject({ failed: true, newSecretCount: 0, limitedStagedFiles: 1 });
      expect(partial.stdout).not.toContain(token);
      const permissive = await runCli(repo, [
        "analyze",
        "--staged",
        "--initial",
        "--policy",
        "new-secrets",
        "--format",
        "json",
      ]);
      expect(permissive.exitCode, permissive.stderr).toBe(0);
      expect(JSON.parse(permissive.stdout).coverage.limited).toHaveLength(1);
      const text = await runCli(repo, ["analyze", "--staged", "--initial", "--policy", "complete-review"]);
      expect(text.stdout).toContain("Custom-pattern content limited: 1 file(s).");
      expect(text.stdout).toContain("Partially scanned staged content: 1 file(s).");
      expect(text.stdout).not.toContain(token);
      const sarif = await runCli(repo, [
        "analyze",
        "--staged",
        "--initial",
        "--policy",
        "complete-review",
        "--format",
        "sarif",
      ]);
      expect(sarif.exitCode, sarif.stderr).toBe(1);
      const run = JSON.parse(sarif.stdout).runs[0];
      expect(run.properties.analysisCoverage.limited).toEqual(result.coverage.limited);
      expect(run.properties.analysisPolicy).toMatchObject({ failed: true, limitedStagedFiles: 1 });
      expect(sarif.stdout).not.toContain(token);

      execFileSync("git", ["config", "user.name", "Test User"], { cwd: repo });
      execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: repo });
      await writeFile(path.join(repo, "client.txt"), token + "\n" + "x".repeat(4097));
      execFileSync("git", ["add", "client.txt"], { cwd: repo });
      execFileSync("git", ["commit", "-m", "baseline"], { cwd: repo });
      await writeFile(path.join(repo, "client.txt"), token + "\n// changed\n");
      execFileSync("git", ["add", "client.txt"], { cwd: repo });
      const baseline = await runCli(repo, [
        "analyze",
        "--staged",
        "--baseline",
        "HEAD",
        "--policy",
        "complete-review",
        "--format",
        "json",
      ]);
      expect(baseline.exitCode, baseline.stderr).toBe(1);
      const compared = JSON.parse(baseline.stdout);
      expect(compared.coverage).not.toHaveProperty("limited");
      expect(compared.baselineComparison).toMatchObject({
        suppressedExistingSecrets: 1,
        limited: [{ path: "client.txt" }],
      });
      expect(compared.policyEvaluation).toMatchObject({
        failed: true,
        newSecretCount: 0,
        limitedStagedFiles: 0,
        limitedBaselineFiles: 1,
      });
      expect(baseline.stdout).not.toContain(token);
    } finally {
      await removeTempDir(repo);
    }
  }, 30_000);
});
