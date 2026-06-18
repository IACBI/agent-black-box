import { writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { collectGitSnapshot, getRepositoryRoot, isGitRepository } from "../src/git/git.js";
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
      await expect(getRepositoryRoot(dir)).resolves.toBe(dir.replace(/\\/g, "/"));
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
        insertions: 3
      });
      expect(snapshot.diffSummaryText).toContain("estimated");
    } finally {
      await removeTempDir(dir);
    }
  });
});
