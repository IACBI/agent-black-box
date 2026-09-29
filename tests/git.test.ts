import { execFileSync } from "node:child_process";
import { mkdir, realpath, rename, writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { collectGitChangesBetween, collectGitSnapshot, getRepositoryRoot, isGitRepository } from "../src/git/git.js";
import { createTempDir, initGitRepo, removeTempDir } from "./testUtils.js";

describe("git helpers", () => {
  it("returns false outside a Git repository", async () => {
    const dir = await createTempDir();
    try {
      await expect(isGitRepository(dir)).resolves.toBe(false);
      await expect(getRepositoryRoot(dir)).resolves.toBeNull();
    } finally {
      await removeTempDir(dir);
    }
  });

  it("detects a Git repository", async () => {
    const dir = await createTempDir();
    try {
      initGitRepo(dir);
      await expect(isGitRepository(dir)).resolves.toBe(true);
      await expect(getRepositoryRoot(dir)).resolves.toBe((await realpath(dir)).replace(/\\/g, "/"));
    } finally {
      await removeTempDir(dir);
    }
  });

  it("estimates line counts for untracked text files", async () => {
    const dir = await createTempDir();
    try {
      initGitRepo(dir);
      await writeFile(`${dir}/new-file.txt`, "one\ntwo\nthree\n", "utf8");

      const snapshot = await collectGitSnapshot(dir);
      const file = snapshot.changedFiles.find((entry) => entry.path === "new-file.txt");

      expect(file).toMatchObject({
        path: "new-file.txt",
        status: "added",
        insertions: 3,
        deletions: 0,
        kind: "text",
        lineStatsSource: "estimated",
      });
      expect(snapshot.diffSummaryText).toContain("estimated");
    } finally {
      await removeTempDir(dir);
    }
  });

  it("counts empty files, CRLF, and unterminated final lines consistently", async () => {
    const dir = await createTempDir();
    try {
      initGitRepo(dir);
      await writeFile(`${dir}/empty.txt`, "");
      await writeFile(`${dir}/crlf.txt`, "one\r\ntwo\r\n");
      await writeFile(`${dir}/unterminated.txt`, "one\ntwo");
      const snapshot = await collectGitSnapshot(dir);
      expect(Object.fromEntries(snapshot.changedFiles.map((file) => [file.path, file.insertions]))).toEqual({
        "empty.txt": 0,
        "crlf.txt": 2,
        "unterminated.txt": 2,
      });
    } finally {
      await removeTempDir(dir);
    }
  });

  it("classifies untracked binary files without estimating text lines", async () => {
    const dir = await createTempDir();
    try {
      initGitRepo(dir);
      await writeFile(`${dir}/image.bin`, Buffer.from([0, 1, 2, 3, 255, 0, 4]));

      const snapshot = await collectGitSnapshot(dir);
      const file = snapshot.changedFiles.find((entry) => entry.path === "image.bin");

      expect(file).toMatchObject({
        path: "image.bin",
        status: "added",
        kind: "binary",
        lineStatsSource: "skipped",
      });
      expect(file?.insertions).toBeUndefined();
      expect(snapshot.diffSummaryText).toContain("line counts were skipped");
    } finally {
      await removeTempDir(dir);
    }
  });

  it("collects exact tracked text line counts for large changes and Unicode paths", async () => {
    const dir = await createTempDir();
    try {
      initGitRepo(dir);
      execFileSync("git", ["config", "core.autocrlf", "false"], { cwd: dir });
      execFileSync("git", ["config", "user.email", "tests@example.invalid"], { cwd: dir });
      execFileSync("git", ["config", "user.name", "Agent Black Box Tests"], { cwd: dir });
      await writeFile(`${dir}/large.txt`, "old\n");
      await writeFile(`${dir}/çalışma #%.txt`, "old\n");
      await writeFile(`${dir}/binary.dat`, Buffer.from([0, 1, 2]));
      execFileSync("git", ["add", "."], { cwd: dir });
      execFileSync("git", ["commit", "-m", "baseline"], { cwd: dir });
      await writeFile(`${dir}/large.txt`, "new\n".repeat(10_000));
      await writeFile(`${dir}/çalışma #%.txt`, "new\nextra\n");
      await writeFile(`${dir}/binary.dat`, Buffer.from([0, 3, 4]));

      const snapshot = await collectGitSnapshot(dir);
      expect(snapshot.changedFiles.find((file) => file.path === "large.txt")).toMatchObject({
        insertions: 10_000,
        deletions: 1,
        lineStatsSource: "git",
      });
      expect(snapshot.changedFiles.find((file) => file.path === "çalışma #%.txt")).toMatchObject({
        insertions: 2,
        deletions: 1,
        lineStatsSource: "git",
      });
      const binary = snapshot.changedFiles.find((file) => file.path === "binary.dat");
      expect(binary?.kind).toBe("binary");
      expect(binary?.insertions).toBeUndefined();
      expect(binary?.deletions).toBeUndefined();
      expect(binary?.lineStatsSource).toBeUndefined();
    } finally {
      await removeTempDir(dir);
    }
  });

  it("attributes unstaged rename line counts to the destination", async () => {
    const dir = await createTempDir();
    try {
      initGitRepo(dir);
      execFileSync("git", ["config", "core.autocrlf", "false"], { cwd: dir });
      execFileSync("git", ["config", "user.email", "tests@example.invalid"], { cwd: dir });
      execFileSync("git", ["config", "user.name", "Agent Black Box Tests"], { cwd: dir });
      await writeFile(`${dir}/old.txt`, "one\ntwo\nthree\n");
      execFileSync("git", ["add", "."], { cwd: dir });
      execFileSync("git", ["commit", "-m", "baseline"], { cwd: dir });
      await rename(`${dir}/old.txt`, `${dir}/new.txt`);
      await writeFile(`${dir}/new.txt`, "one\ntwo\nthree\nfour\n");
      execFileSync("git", ["add", "--intent-to-add", "new.txt"], { cwd: dir });

      expect((await collectGitSnapshot(dir)).changedFiles).toEqual([
        { path: "new.txt", status: "renamed", insertions: 1, deletions: 0, lineStatsSource: "git" },
      ]);
    } finally {
      await removeTempDir(dir);
    }
  });

  it.skipIf(process.platform === "win32")("preserves tab characters in tracked Git paths", async () => {
    const dir = await createTempDir();
    try {
      initGitRepo(dir);
      execFileSync("git", ["config", "user.email", "tests@example.invalid"], { cwd: dir });
      execFileSync("git", ["config", "user.name", "Agent Black Box Tests"], { cwd: dir });
      const relativePath = "with\ttab.txt";
      await writeFile(`${dir}/${relativePath}`, "old\n");
      execFileSync("git", ["add", "."], { cwd: dir });
      execFileSync("git", ["commit", "-m", "baseline"], { cwd: dir });
      await writeFile(`${dir}/${relativePath}`, "new\nextra\n");

      expect((await collectGitSnapshot(dir)).changedFiles).toEqual([
        expect.objectContaining({ path: relativePath, insertions: 2, deletions: 1, lineStatsSource: "git" }),
      ]);
    } finally {
      await removeTempDir(dir);
    }
  });

  it("collects committed changes between session HEAD revisions and respects excludes", async () => {
    const dir = await createTempDir();
    try {
      initGitRepo(dir);
      execFileSync("git", ["config", "user.email", "tests@example.invalid"], { cwd: dir });
      execFileSync("git", ["config", "user.name", "Agent Black Box Tests"], { cwd: dir });
      await mkdir(`${dir}/src`, { recursive: true });
      await writeFile(`${dir}/src/index.ts`, "export const value = 1;\n", "utf8");
      execFileSync("git", ["add", "."], { cwd: dir });
      execFileSync("git", ["commit", "-m", "initial"], { cwd: dir });
      const startHead = (await collectGitSnapshot(dir)).head;
      await expect(collectGitChangesBetween(dir, undefined, startHead, ["dist"])).resolves.toEqual([
        { path: "src/index.ts", status: "added" },
      ]);

      await writeFile(`${dir}/src/index.ts`, "export const value = 2;\n", "utf8");
      await mkdir(`${dir}/dist`, { recursive: true });
      await writeFile(`${dir}/dist/output.js`, "generated\n", "utf8");
      execFileSync("git", ["add", "."], { cwd: dir });
      execFileSync("git", ["commit", "-m", "change files"], { cwd: dir });
      const endHead = (await collectGitSnapshot(dir)).head;

      await expect(collectGitChangesBetween(dir, startHead, endHead, ["dist"])).resolves.toEqual([
        { path: "src/index.ts", status: "modified" },
      ]);
    } finally {
      await removeTempDir(dir);
    }
  }, 20_000);

  it("rejects untrusted revision strings before invoking Git", async () => {
    const dir = await createTempDir();
    try {
      initGitRepo(dir);
      await expect(collectGitChangesBetween(dir, "--output=unexpected", "a".repeat(40))).rejects.toThrow(
        "full hexadecimal object IDs"
      );
    } finally {
      await removeTempDir(dir);
    }
  });
});
