import { describe, expect, it } from "vitest";
import { getRepositoryRoot, isGitRepository } from "../src/git/git.js";
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
});
