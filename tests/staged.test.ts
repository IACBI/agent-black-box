import { execFileSync } from "node:child_process";
import { rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { analyzeChangedFiles } from "../src/analyze/analyzer.js";
import { compareAnalysisWithBaseline } from "../src/analyze/baseline.js";
import { evaluateAnalysisPolicy } from "../src/analyze/policy.js";
import {
  collectBaselineAnalysisInputFiles,
  collectStagedAnalysisInputFiles,
  resolveBaselineCommit,
} from "../src/analyze/staged.js";
import { DEFAULT_CONFIG } from "../src/config/defaults.js";
import { createTempDir, initGitRepo, removeTempDir } from "./testUtils.js";

describe("staged analysis", () => {
  it.each([
    { maxFileSizeKb: 1, maxBytes: 1024 },
    { maxFileSizeKb: 500, maxBytes: 256 * 1024 },
  ])(
    "enforces the $maxBytes-byte limit for staged and baseline blobs",
    async ({ maxFileSizeKb, maxBytes }) => {
      const repo = await createTempDir();
      try {
        initGitRepo(repo);
        execFileSync("git", ["config", "user.email", "tests@example.invalid"], { cwd: repo });
        execFileSync("git", ["config", "user.name", "Agent Black Box Tests"], { cwd: repo });
        const config = { ...DEFAULT_CONFIG, maxFileSizeKb };
        for (const extraBytes of [0, 1, 2]) {
          await writeFile(path.join(repo, `limit-${extraBytes}.txt`), "a".repeat(maxBytes + extraBytes), "utf8");
        }
        execFileSync("git", ["add", "-A"], { cwd: repo });
        execFileSync("git", ["commit", "-m", "baseline"], { cwd: repo });
        const commit = await resolveBaselineCommit(repo, "HEAD");
        for (const extraBytes of [0, 1, 2]) {
          await writeFile(path.join(repo, `limit-${extraBytes}.txt`), "b".repeat(maxBytes + extraBytes), "utf8");
        }
        execFileSync("git", ["add", "-A"], { cwd: repo });

        const files = await collectStagedAnalysisInputFiles(repo, config);
        const baseline = await collectBaselineAnalysisInputFiles(repo, files, config, commit);
        for (const collected of [files, baseline]) {
          expect(collected.find((file) => file.path === "limit-0.txt")).toMatchObject({ kind: "text" });
          expect(collected.find((file) => file.path === "limit-0.txt")?.content).toHaveLength(maxBytes);
          for (const extraBytes of [1, 2]) {
            const file = collected.find((entry) => entry.path === `limit-${extraBytes}.txt`);
            expect(file).toMatchObject({ kind: "large" });
            expect(file?.content).toBeUndefined();
            expect(file?.analysisSkipReason).toContain(`exceeds ${maxBytes} bytes`);
          }
        }

        const overflowFiles = files.filter((file) => file.path === "limit-1.txt");
        const result = {
          ...compareAnalysisWithBaseline(overflowFiles, [], analyzeChangedFiles(overflowFiles), commit),
          coverage: { source: "index" as const, scannedTextFiles: 0, skipped: [] },
        };
        expect(evaluateAnalysisPolicy(result, overflowFiles, "complete-review")).toMatchObject({
          failed: true,
          skippedStagedFiles: 1,
        });
      } finally {
        await removeTempDir(repo);
      }
    },
    20_000
  );

  it("reads staged content even when the working tree has changed", async () => {
    const repo = await createTempDir();
    try {
      initGitRepo(repo);
      const rawValue = "test_credential_value_987654321";
      const filePath = path.join(repo, "settings.ts");
      await writeFile(filePath, `const apiKey = "${rawValue}";\n`, "utf8");
      execFileSync("git", ["add", "settings.ts"], { cwd: repo });
      await writeFile(filePath, "const apiKey = process.env.API_KEY;\n", "utf8");

      const files = await collectStagedAnalysisInputFiles(repo, DEFAULT_CONFIG);
      expect(files).toMatchObject([{ path: "settings.ts", status: "added", kind: "text" }]);
      const analysis = analyzeChangedFiles(files);
      expect(analysis.findings).toContainEqual(
        expect.objectContaining({ category: "Possible secret", path: "settings.ts" })
      );
      expect(JSON.stringify(analysis)).not.toContain(rawValue);
    } finally {
      await removeTempDir(repo);
    }
  });

  it("classifies deleted, binary, and oversized staged entries without scanning their content", async () => {
    const repo = await createTempDir();
    try {
      initGitRepo(repo);
      execFileSync("git", ["config", "user.email", "tests@example.invalid"], { cwd: repo });
      execFileSync("git", ["config", "user.name", "Agent Black Box Tests"], { cwd: repo });
      await writeFile(path.join(repo, "deleted.txt"), "original\n", "utf8");
      execFileSync("git", ["add", "deleted.txt"], { cwd: repo });
      execFileSync("git", ["commit", "-m", "baseline"], { cwd: repo });
      await rm(path.join(repo, "deleted.txt"));
      await writeFile(path.join(repo, "binary.dat"), Buffer.from([0, 1, 2, 3]));
      await writeFile(path.join(repo, "oversized.txt"), "a".repeat(300_000), "utf8");
      execFileSync("git", ["add", "-A"], { cwd: repo });

      const files = await collectStagedAnalysisInputFiles(repo, DEFAULT_CONFIG);
      expect(files).toContainEqual(expect.objectContaining({ path: "deleted.txt", status: "deleted" }));
      expect(files).toContainEqual(expect.objectContaining({ path: "binary.dat", kind: "binary" }));
      expect(files).toContainEqual(expect.objectContaining({ path: "oversized.txt", kind: "large" }));
      expect(files.every((file) => file.content === undefined)).toBe(true);
    } finally {
      await removeTempDir(repo);
    }
  }, 15_000);

  it("reports a new staged credential while suppressing unchanged baseline content", async () => {
    const repo = await createTempDir();
    try {
      initGitRepo(repo);
      execFileSync("git", ["config", "user.email", "tests@example.invalid"], { cwd: repo });
      execFileSync("git", ["config", "user.name", "Agent Black Box Tests"], { cwd: repo });
      const oldValue = "test_credential_old_987654321";
      const newValue = "test_credential_new_987654321";
      const filePath = path.join(repo, "settings.ts");
      await writeFile(filePath, `const apiKey = "${oldValue}";\n`, "utf8");
      execFileSync("git", ["add", "settings.ts"], { cwd: repo });
      execFileSync("git", ["commit", "-m", "baseline"], { cwd: repo });
      await writeFile(filePath, `const apiKey = "${oldValue}";\nconst clientSecret = "${newValue}";\n`, "utf8");
      execFileSync("git", ["add", "settings.ts"], { cwd: repo });

      const files = await collectStagedAnalysisInputFiles(repo, DEFAULT_CONFIG);
      const commit = await resolveBaselineCommit(repo, "HEAD");
      const baseline = await collectBaselineAnalysisInputFiles(repo, files, DEFAULT_CONFIG, commit);
      const compared = compareAnalysisWithBaseline(files, baseline, analyzeChangedFiles(files), commit);

      expect(compared.findings.filter((finding) => finding.kind === "possible-secret")).toMatchObject([
        { path: "settings.ts", line: 2 },
      ]);
      expect(compared.baselineComparison).toMatchObject({ suppressedExistingSecrets: 1, scannedTextFiles: 1 });
      expect(compared.findings.some((finding) => finding.kind === "metadata-risk")).toBe(true);
      expect(JSON.stringify(compared)).not.toContain(oldValue);
      expect(JSON.stringify(compared)).not.toContain(newValue);
      await expect(resolveBaselineCommit(repo, "--invalid")).rejects.toThrow("existing Git commit");
    } finally {
      await removeTempDir(repo);
    }
  }, 15_000);

  it("keeps duplicate or renamed staged secret lines that have no baseline counterpart", () => {
    const line = 'const apiKey = "test_credential_value_987654321";';
    const staged = [
      { path: "renamed.ts", status: "renamed" as const, kind: "text" as const, content: `${line}\n${line}\n` },
    ];
    const baseline = [{ path: "renamed.ts", status: "renamed" as const, kind: "text" as const, content: `${line}\n` }];
    const compared = compareAnalysisWithBaseline(staged, baseline, analyzeChangedFiles(staged), "a".repeat(40));
    expect(compared.findings.filter((finding) => finding.kind === "possible-secret")).toHaveLength(1);
    expect(compared.baselineComparison?.suppressedExistingSecrets).toBe(1);

    const absent = compareAnalysisWithBaseline(
      staged,
      [{ path: "renamed.ts", status: "renamed", kind: "missing" }],
      analyzeChangedFiles(staged),
      "a".repeat(40)
    );
    expect(absent.findings.filter((finding) => finding.kind === "possible-secret")).toHaveLength(2);
    expect(absent.baselineComparison?.absentFiles).toBe(1);
  });

  it("matches unchanged secret lines across a verified rename while keeping new findings", async () => {
    const repo = await createTempDir();
    try {
      initGitRepo(repo);
      execFileSync("git", ["config", "user.email", "tests@example.invalid"], { cwd: repo });
      execFileSync("git", ["config", "user.name", "Agent Black Box Tests"], { cwd: repo });
      const line = 'const apiKey = "test_credential_value_987654321";\n';
      const shared = Array.from({ length: 8 }, (_, index) => `export const setting${index} = ${index};\n`).join("");
      await writeFile(path.join(repo, "old-config.ts"), line + shared, "utf8");
      await writeFile(path.join(repo, ".env"), "MODE=example\n", "utf8");
      execFileSync("git", ["add", "-A"], { cwd: repo });
      execFileSync("git", ["commit", "-m", "baseline"], { cwd: repo });
      await rename(path.join(repo, "old-config.ts"), path.join(repo, "new-config.ts"));
      await rm(path.join(repo, ".env"));
      execFileSync("git", ["add", "-A"], { cwd: repo });

      const files = await collectStagedAnalysisInputFiles(repo, DEFAULT_CONFIG);
      const commit = await resolveBaselineCommit(repo, "HEAD");
      const baseline = await collectBaselineAnalysisInputFiles(repo, files, DEFAULT_CONFIG, commit);
      const result = compareAnalysisWithBaseline(files, baseline, analyzeChangedFiles(files), commit);

      expect(files).toContainEqual(expect.objectContaining({ path: "new-config.ts", status: "renamed" }));
      expect(result.findings.some((finding) => finding.kind === "possible-secret")).toBe(false);
      expect(result.findings).toContainEqual(expect.objectContaining({ path: ".env", kind: "metadata-risk" }));
      expect(result.baselineComparison).toMatchObject({
        suppressedExistingSecrets: 1,
        absentFiles: 0,
        renameSources: [{ path: "new-config.ts", sourcePath: "old-config.ts", suppressedExistingSecrets: 1 }],
      });

      const newValue = "test_credential_new_987654321";
      await writeFile(
        path.join(repo, "new-config.ts"),
        `${line}${shared}const clientSecret = "${newValue}";\n`,
        "utf8"
      );
      execFileSync("git", ["add", "-A"], { cwd: repo });
      const updatedFiles = await collectStagedAnalysisInputFiles(repo, DEFAULT_CONFIG);
      const updatedBaseline = await collectBaselineAnalysisInputFiles(repo, updatedFiles, DEFAULT_CONFIG, commit);
      const updated = compareAnalysisWithBaseline(
        updatedFiles,
        updatedBaseline,
        analyzeChangedFiles(updatedFiles),
        commit
      );
      expect(updated.findings.filter((finding) => finding.kind === "possible-secret")).toMatchObject([
        { path: "new-config.ts", line: 10 },
      ]);
      expect(updated.baselineComparison?.suppressedExistingSecrets).toBe(1);
      expect(updated.baselineComparison?.renameSources).toEqual([
        { path: "new-config.ts", sourcePath: "old-config.ts", suppressedExistingSecrets: 1 },
      ]);
      expect(JSON.stringify(updated)).not.toContain(newValue);

      const excludedSourceConfig = { ...DEFAULT_CONFIG, exclude: [...DEFAULT_CONFIG.exclude, "old-config.ts"] };
      const excludedBaseline = await collectBaselineAnalysisInputFiles(
        repo,
        updatedFiles,
        excludedSourceConfig,
        commit
      );
      const withoutSource = compareAnalysisWithBaseline(
        updatedFiles,
        excludedBaseline,
        analyzeChangedFiles(updatedFiles),
        commit
      );
      expect(withoutSource.findings.filter((finding) => finding.kind === "possible-secret")).toHaveLength(2);
      expect(withoutSource.baselineComparison).toMatchObject({ suppressedExistingSecrets: 0, absentFiles: 1 });
      expect(withoutSource.baselineComparison?.renameSources).toEqual([]);
    } finally {
      await removeTempDir(repo);
    }
  }, 15_000);
});
