import { mkdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AnalysisInputFile } from "../src/analyze/analyzer.js";
import { MAX_ANALYSIS_BYTES, createAnalysisContentBudget } from "../src/analyze/limits.js";
import { collectAnalysisInputFiles, summarizeAnalysisCoverage } from "../src/analyze/worktree.js";
import { meetsSeverity, severityRank } from "../src/utils/severity.js";
import { sleep } from "../src/utils/timing.js";
import { createTempDir, removeTempDir } from "./testUtils.js";

describe("working-tree analysis input", () => {
  it("admits text deterministically by encoded bytes while excluding binary, missing, and oversized paths", async () => {
    const repo = await createTempDir("abb-worktree-budget-");
    try {
      await writeFile(path.join(repo, "first.txt"), "é");
      await writeFile(path.join(repo, "binary.dat"), Buffer.from([0, 1, 2]));
      await writeFile(path.join(repo, "large.txt"), "x".repeat(50));
      await writeFile(path.join(repo, "over.txt"), "oversized budget");
      await writeFile(path.join(repo, "last.txt"), "a");
      await writeFile(path.join(repo, "empty.txt"), "");
      const changed = ["first.txt", "binary.dat", "missing.txt", "large.txt", "over.txt", "last.txt", "empty.txt"].map(
        (filePath) => ({ path: filePath, status: "added" as const })
      );
      for (let run = 0; run < 2; run += 1) {
        const contentBudget = createAnalysisContentBudget(3);
        const files = await collectAnalysisInputFiles(repo, changed, 30, { contentBudget });
        expect(files.map((file) => file.kind)).toEqual([
          "text",
          "binary",
          "missing",
          "large",
          "unknown",
          "text",
          "text",
        ]);
        expect(files.filter((file) => file.content !== undefined).map((file) => file.content)).toEqual(["é", "a", ""]);
        expect(files[4]).toMatchObject({
          analysisSkipReason: expect.stringContaining("aggregate analysis budget of 3 bytes"),
        });
        expect(contentBudget.remainingBytes).toBe(0);
        expect(summarizeAnalysisCoverage(files, "worktree")).toMatchObject({ scannedTextFiles: 3 });
      }
    } finally {
      await removeTempDir(repo);
    }
  });

  it("allows empty content with a zero budget and rejects invalid budget sizes", async () => {
    const repo = await createTempDir("abb-worktree-zero-budget-");
    try {
      await writeFile(path.join(repo, "empty.txt"), "");
      await writeFile(path.join(repo, "content.txt"), "a");
      const files = await collectAnalysisInputFiles(
        repo,
        [
          { path: "empty.txt", status: "added" },
          { path: "content.txt", status: "added" },
        ],
        10,
        { contentBudget: createAnalysisContentBudget(0) }
      );
      expect(files[0]).toMatchObject({ kind: "text", content: "" });
      expect(files[1]).toMatchObject({ kind: "unknown" });
      expect(files[1]).not.toHaveProperty("content");
      for (const invalid of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
        expect(() => createAnalysisContentBudget(invalid)).toThrow("non-negative safe integer");
      }
    } finally {
      await removeTempDir(repo);
    }
  });

  it("counts the retained UTF-8 encoding when a mostly-text file contains an invalid byte", async () => {
    const repo = await createTempDir("abb-worktree-decoding-budget-");
    try {
      const bytes = Buffer.concat([Buffer.alloc(200, "a"), Buffer.from([0xff])]);
      await writeFile(path.join(repo, "decoded.txt"), bytes);
      const files = [{ path: "decoded.txt", status: "added" as const }];
      const tooSmall = createAnalysisContentBudget(bytes.length);
      const [skipped] = await collectAnalysisInputFiles(repo, files, 300, { contentBudget: tooSmall });
      expect(skipped.kind).toBe("unknown");
      expect(skipped).not.toHaveProperty("content");
      expect(tooSmall.remainingBytes).toBe(bytes.length);
      const exact = createAnalysisContentBudget(203);
      const [scanned] = await collectAnalysisInputFiles(repo, files, 300, { contentBudget: exact });
      expect(scanned).toMatchObject({ kind: "text", content: `${"a".repeat(200)}\uFFFD` });
      expect(exact.remainingBytes).toBe(0);
    } finally {
      await removeTempDir(repo);
    }
  });
  it("reads text content and records why other changed paths were not read", async () => {
    const repo = await createTempDir("abb-worktree-");
    try {
      await mkdir(path.join(repo, "src"));
      await writeFile(path.join(repo, "src", "a.ts"), "export const a = 1;\n");
      await writeFile(path.join(repo, "src", "binary.dat"), Buffer.from([0, 1, 2, 3]));
      await writeFile(path.join(repo, "src", "big.txt"), "x".repeat(2048));

      const files = await collectAnalysisInputFiles(
        repo,
        [
          { path: "src/a.ts", status: "modified" },
          { path: "src/binary.dat", status: "added" },
          { path: "src/big.txt", status: "added" },
          { path: "src/missing.ts", status: "modified" },
          { path: "src/removed.ts", status: "deleted" },
          { path: "../outside.txt", status: "modified" },
        ],
        1024
      );

      expect(files[0]).toMatchObject({ path: "src/a.ts", kind: "text", content: "export const a = 1;\n" });
      expect(files[1]).toMatchObject({ path: "src/binary.dat", kind: "binary" });
      expect(files[1]).not.toHaveProperty("content");
      expect(files[2]).toMatchObject({ path: "src/big.txt", kind: "large" });
      expect(files[2]).not.toHaveProperty("content");
      expect(files[3]).toMatchObject({ path: "src/missing.ts", kind: "missing" });
      expect(files[4]).toEqual({ path: "src/removed.ts", status: "deleted" });
      expect(files[5]).toEqual({ path: "../outside.txt", status: "modified" });
      expect(files.map((file) => file.path)).toEqual([
        "src/a.ts",
        "src/binary.dat",
        "src/big.txt",
        "src/missing.ts",
        "src/removed.ts",
        "../outside.txt",
      ]);
    } finally {
      await removeTempDir(repo);
    }
  });

  it("caps the bytes read at the analysis limit even when the configured limit is larger", async () => {
    const repo = await createTempDir("abb-worktree-");
    try {
      await writeFile(path.join(repo, "just-under.txt"), "a".repeat(MAX_ANALYSIS_BYTES));
      await writeFile(path.join(repo, "just-over.txt"), "a".repeat(MAX_ANALYSIS_BYTES + 1));
      const [under, over] = await collectAnalysisInputFiles(
        repo,
        [
          { path: "just-under.txt", status: "added" },
          { path: "just-over.txt", status: "added" },
        ],
        100 * 1024 * 1024
      );

      expect(under.kind).toBe("text");
      expect(over.kind).toBe("large");
      expect(over).not.toHaveProperty("content");
    } finally {
      await removeTempDir(repo);
    }
  });

  it("does not read through a link that leaves the repository", async () => {
    const repo = await createTempDir("abb-worktree-");
    const outside = await createTempDir("abb-worktree-outside-");
    try {
      await writeFile(path.join(outside, "secret.txt"), "password = hunter2hunter2\n");
      await symlink(outside, path.join(repo, "linked"), process.platform === "win32" ? "junction" : "dir");
      const [file] = await collectAnalysisInputFiles(repo, [{ path: "linked/secret.txt", status: "added" }], 4096);

      expect(file).not.toHaveProperty("content");
      expect(file.kind).not.toBe("text");
    } finally {
      await removeTempDir(repo);
      await removeTempDir(outside);
    }
  });

  it("summarizes coverage with a reason for every unscanned path", () => {
    const files: AnalysisInputFile[] = [
      { path: "a.ts", status: "modified", kind: "text", content: "x" },
      { path: "empty.ts", status: "modified", kind: "text", content: "" },
      { path: "gone.ts", status: "deleted" },
      { path: "bin.dat", status: "added", kind: "binary", analysisSkipReason: "Binary content is not scanned." },
      { path: "mystery.ts", status: "modified", kind: "text" },
    ];

    expect(summarizeAnalysisCoverage(files, "index")).toEqual({
      source: "index",
      scannedTextFiles: 2,
      skipped: [
        { path: "gone.ts", reason: "Deleted files have no current content to scan." },
        { path: "bin.dat", reason: "Binary content is not scanned." },
        { path: "mystery.ts", reason: "Text content was unavailable for this changed path." },
      ],
    });
    expect(summarizeAnalysisCoverage([], "worktree")).toEqual({ source: "worktree", scannedTextFiles: 0, skipped: [] });
  });
});

describe("severity helpers", () => {
  it("orders none below low, medium and high", () => {
    expect(["none", "low", "medium", "high"].map((level) => severityRank(level as "none"))).toEqual([0, 1, 2, 3]);
  });

  it("applies thresholds inclusively", () => {
    expect(meetsSeverity("high", "high")).toBe(true);
    expect(meetsSeverity("medium", "high")).toBe(false);
    expect(meetsSeverity("high", "low")).toBe(true);
    expect(meetsSeverity("none", "low")).toBe(false);
    expect(meetsSeverity("none", "none")).toBe(true);
  });
});

describe("sleep", () => {
  it("resolves only after the delay has elapsed", async () => {
    const started = performance.now();
    await sleep(30);
    expect(performance.now() - started).toBeGreaterThanOrEqual(25);
  });
});
