import { execFileSync } from "node:child_process";
import { mkdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { analyzeChangedFiles } from "../src/analyze/analyzer.js";
import { compareAnalysisWithBaseline } from "../src/analyze/baseline.js";
import { evaluateAnalysisPolicy } from "../src/analyze/policy.js";
import { createAnalysisContentBudget } from "../src/analyze/limits.js";
import { summarizeAnalysisCoverage } from "../src/analyze/worktree.js";
import {
  collectBaselineAnalysisInputFiles,
  collectStagedAnalysisInputFiles,
  resolveBaselineCommit,
} from "../src/analyze/staged.js";
import { DEFAULT_CONFIG } from "../src/config/defaults.js";
import { createTempDir, initGitRepo, removeTempDir } from "./testUtils.js";

describe("staged analysis", () => {
  it("shares an encoded-content budget across staged and baseline input without allowing incomplete review", async () => {
    const repo = await createTempDir();
    try {
      initGitRepo(repo);
      execFileSync("git", ["config", "user.email", "tests@example.invalid"], { cwd: repo });
      execFileSync("git", ["config", "user.name", "Agent Black Box Tests"], { cwd: repo });
      execFileSync("git", ["config", "core.autocrlf", "false"], { cwd: repo });
      await writeFile(path.join(repo, "a.txt"), "é");
      await writeFile(path.join(repo, "b-binary.dat"), Buffer.from([0, 1]));
      await writeFile(path.join(repo, "c-large.txt"), "x".repeat(2000));
      await writeFile(path.join(repo, "d.txt"), "old");
      execFileSync("git", ["add", "-A"], { cwd: repo });
      execFileSync("git", ["commit", "-m", "baseline"], { cwd: repo });
      const commit = await resolveBaselineCommit(repo, "HEAD");
      await writeFile(path.join(repo, "a.txt"), "😀");
      await writeFile(path.join(repo, "b-binary.dat"), Buffer.from([0, 2]));
      await writeFile(path.join(repo, "c-large.txt"), "y".repeat(2000));
      await writeFile(path.join(repo, "d.txt"), "new");
      execFileSync("git", ["add", "-A"], { cwd: repo });
      const config = { ...DEFAULT_CONFIG, maxFileSizeKb: 1 };
      const contentBudget = createAnalysisContentBudget(9);
      const staged = await collectStagedAnalysisInputFiles(repo, config, { contentBudget });
      expect(staged.map((file) => file.kind)).toEqual(["text", "binary", "large", "text"]);
      expect(contentBudget.remainingBytes).toBe(2);
      const baseline = await collectBaselineAnalysisInputFiles(repo, staged, config, commit, { contentBudget });
      expect(baseline.map((file) => file.kind)).toEqual(["text", "binary", "large", "unknown"]);
      expect(baseline[0]?.content).toBe("é");
      expect(baseline[3]).not.toHaveProperty("content");
      expect(contentBudget.remainingBytes).toBe(0);
      const reviewed = staged.filter((file) => file.path === "d.txt");
      const result = compareAnalysisWithBaseline(
        reviewed,
        baseline.filter((file) => file.path === "d.txt"),
        {
          ...analyzeChangedFiles(reviewed),
          coverage: summarizeAnalysisCoverage(reviewed, "index"),
        },
        commit
      );
      expect(result.baselineComparison?.skipped).toContainEqual({
        path: "d.txt",
        reason: expect.stringContaining("aggregate analysis budget of 9 bytes"),
      });
      expect(evaluateAnalysisPolicy(result, reviewed, "complete-review")).toMatchObject({
        failed: true,
        skippedStagedFiles: 0,
        skippedBaselineFiles: 1,
      });

      const limited = await collectStagedAnalysisInputFiles(repo, config, {
        contentBudget: createAnalysisContentBudget(4),
      });
      expect(limited[3]).toMatchObject({
        kind: "unknown",
        analysisSkipReason: expect.stringContaining("aggregate analysis budget"),
      });
      const limitedReview = limited.filter((file) => file.path === "d.txt");
      const limitedResult = compareAnalysisWithBaseline(
        limitedReview,
        [],
        {
          ...analyzeChangedFiles(limitedReview),
          coverage: summarizeAnalysisCoverage(limitedReview, "index"),
        },
        commit
      );
      expect(evaluateAnalysisPolicy(limitedResult, limitedReview, "complete-review")).toMatchObject({
        failed: true,
        skippedStagedFiles: 1,
        skippedBaselineFiles: 0,
      });
    } finally {
      await removeTempDir(repo);
    }
  }, 20_000);
  it("preserves baseline content, classifications, exact paths, order, and duplicates across batches", async () => {
    const repo = await createTempDir();
    try {
      initGitRepo(repo);
      execFileSync("git", ["config", "user.email", "tests@example.invalid"], { cwd: repo });
      execFileSync("git", ["config", "user.name", "Agent Black Box Tests"], { cwd: repo });
      execFileSync("git", ["config", "core.autocrlf", "false"], { cwd: repo });
      const paths = [
        ...Array.from({ length: 130 }, (_, index) => `batch-${index}-${"segment-".repeat(12)}.txt`),
        "literal[1].txt",
        "literal1.txt",
        "çalışma #%.txt",
        ...(process.platform === "win32" ? [] : ["with\ttab.txt", "with\nnewline.txt", "star*.txt", "question?.txt"]),
      ];
      const contents = new Map(paths.map((filePath, index) => [filePath, `baseline content ${index}\n`]));
      await Promise.all(paths.map((filePath) => writeFile(path.join(repo, filePath), contents.get(filePath)!)));
      await writeFile(path.join(repo, "deleted.txt"), "deleted baseline\n");
      await writeFile(path.join(repo, "binary.dat"), Buffer.from([0, 1, 2]));
      await writeFile(path.join(repo, "oversized.txt"), "a".repeat(300_000));
      await mkdir(path.join(repo, "replaced-directory"));
      await writeFile(path.join(repo, "replaced-directory", "child.txt"), "unrequested descendant\n");
      execFileSync("git", ["add", "-A"], { cwd: repo });
      execFileSync("git", ["commit", "-m", "baseline"], { cwd: repo });
      const commit = await resolveBaselineCommit(repo, "HEAD");
      await Promise.all(
        paths.map((filePath) => writeFile(path.join(repo, filePath), `updated ${contents.get(filePath)}`))
      );
      await rm(path.join(repo, "deleted.txt"));
      await writeFile(path.join(repo, "binary.dat"), Buffer.from([0, 3, 4]));
      await writeFile(path.join(repo, "oversized.txt"), "b".repeat(300_000));
      await rm(path.join(repo, "replaced-directory"), { recursive: true });
      await writeFile(path.join(repo, "replaced-directory"), "new regular file\n");
      execFileSync("git", ["add", "-A"], { cwd: repo });
      const staged = await collectStagedAnalysisInputFiles(repo, DEFAULT_CONFIG);
      const duplicate = staged.find((file) => file.path === paths[0])!;
      const requested = [...staged.slice().reverse(), duplicate];

      const baseline = await collectBaselineAnalysisInputFiles(repo, requested, DEFAULT_CONFIG, commit);

      expect(baseline.map((file) => file.path)).toEqual(requested.map((file) => file.path));
      for (const filePath of paths) {
        const matching = baseline.filter((file) => file.path === filePath);
        expect(matching).toHaveLength(filePath === duplicate.path ? 2 : 1);
        for (const file of matching) {
          expect(file).toMatchObject({ kind: "text", content: contents.get(filePath) });
        }
      }
      expect(baseline.find((file) => file.path === "deleted.txt")).toMatchObject({ status: "deleted" });
      expect(baseline.find((file) => file.path === "binary.dat")).toMatchObject({ kind: "binary" });
      expect(baseline.find((file) => file.path === "oversized.txt")).toMatchObject({ kind: "large" });
      expect(baseline.find((file) => file.path === "replaced-directory")).toMatchObject({ kind: "missing" });
      expect(baseline.filter((file) => file.kind !== "text").every((file) => file.content === undefined)).toBe(true);
    } finally {
      await removeTempDir(repo);
    }
  }, 30_000);

  it("preserves Git-proven source paths and content across many renamed files", async () => {
    const repo = await createTempDir();
    try {
      initGitRepo(repo);
      execFileSync("git", ["config", "user.email", "tests@example.invalid"], { cwd: repo });
      execFileSync("git", ["config", "user.name", "Agent Black Box Tests"], { cwd: repo });
      execFileSync("git", ["config", "core.autocrlf", "false"], { cwd: repo });
      const contents = Array.from({ length: 70 }, (_, index) => `unique baseline for module ${index}\n`);
      await Promise.all(contents.map((content, index) => writeFile(path.join(repo, `old-${index}.txt`), content)));
      execFileSync("git", ["add", "-A"], { cwd: repo });
      execFileSync("git", ["commit", "-m", "baseline"], { cwd: repo });
      const commit = await resolveBaselineCommit(repo, "HEAD");
      await Promise.all(
        contents.map((_, index) => rename(path.join(repo, `old-${index}.txt`), path.join(repo, `new-${index}.txt`)))
      );
      execFileSync("git", ["add", "-A"], { cwd: repo });
      const staged = await collectStagedAnalysisInputFiles(repo, DEFAULT_CONFIG);

      const baseline = await collectBaselineAnalysisInputFiles(repo, staged, DEFAULT_CONFIG, commit);

      expect(baseline).toHaveLength(contents.length);
      for (const [index, content] of contents.entries()) {
        expect(baseline.find((file) => file.path === `new-${index}.txt`)).toEqual({
          path: `new-${index}.txt`,
          status: "renamed",
          kind: "text",
          content,
          baselineSourcePath: `old-${index}.txt`,
        });
      }
    } finally {
      await removeTempDir(repo);
    }
  }, 30_000);

  it.skipIf(process.platform === "win32")("keeps symbolic-link baseline entries unscanned", async () => {
    const repo = await createTempDir();
    try {
      initGitRepo(repo);
      execFileSync("git", ["config", "user.email", "tests@example.invalid"], { cwd: repo });
      execFileSync("git", ["config", "user.name", "Agent Black Box Tests"], { cwd: repo });
      await writeFile(path.join(repo, "first.txt"), "first target\n");
      await writeFile(path.join(repo, "second.txt"), "second target\n");
      await symlink("first.txt", path.join(repo, "link.txt"));
      execFileSync("git", ["add", "-A"], { cwd: repo });
      execFileSync("git", ["commit", "-m", "baseline"], { cwd: repo });
      const commit = await resolveBaselineCommit(repo, "HEAD");
      await rm(path.join(repo, "link.txt"));
      await symlink("second.txt", path.join(repo, "link.txt"));
      execFileSync("git", ["add", "-A"], { cwd: repo });
      const staged = await collectStagedAnalysisInputFiles(repo, DEFAULT_CONFIG);

      const baseline = await collectBaselineAnalysisInputFiles(repo, staged, DEFAULT_CONFIG, commit);

      expect(baseline).toEqual([
        {
          path: "link.txt",
          status: "modified",
          kind: "not-file",
          analysisSkipReason: "The baseline entry is not a regular file.",
        },
      ]);
    } finally {
      await removeTempDir(repo);
    }
  });

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
