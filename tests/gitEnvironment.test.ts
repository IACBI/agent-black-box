import { execFileSync } from "node:child_process";
import { copyFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG } from "../src/config/defaults.js";
import { createGit } from "../src/git/executable.js";
import { getRepositoryRoot } from "../src/git/git.js";
import { collectStagedAnalysisInputFiles } from "../src/analyze/staged.js";
import { createTempDir, initGitRepo, removeTempDir } from "./testUtils.js";

describe("Git environment compatibility", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("reads staged content from an alternate index without modifying the default index", async () => {
    const repo = await createTempDir("abb-git-environment-");
    try {
      initGitRepo(repo);
      const file = path.join(repo, "source.ts");
      await writeFile(file, "export const value = 1;\n");
      execFileSync("git", ["add", "."], { cwd: repo });
      const alternateIndex = path.join(repo, "alternate-index");
      await copyFile(path.join(repo, ".git", "index"), alternateIndex);
      await writeFile(file, "export const value = 2;\n");
      execFileSync("git", ["add", "source.ts"], {
        cwd: repo,
        env: { ...process.env, GIT_INDEX_FILE: alternateIndex },
      });
      vi.stubEnv("GIT_INDEX_FILE", alternateIndex);

      const staged = await collectStagedAnalysisInputFiles(repo, DEFAULT_CONFIG);
      expect(staged.find((entry) => entry.path === "source.ts")?.content).toBe("export const value = 2;\n");
      const defaultContent = execFileSync("git", ["show", ":source.ts"], {
        cwd: repo,
        env: { ...process.env, GIT_INDEX_FILE: path.join(repo, ".git", "index") },
        encoding: "utf8",
      });
      expect(defaultContent).toBe("export const value = 1;\n");
    } finally {
      await removeTempDir(repo);
    }
  });

  it("preserves explicit repository and worktree discovery", async () => {
    const repo = await createTempDir("abb-git-discovery-");
    const outside = await createTempDir("abb-git-outside-");
    try {
      initGitRepo(repo);
      vi.stubEnv("GIT_DIR", path.join(repo, ".git"));
      vi.stubEnv("GIT_WORK_TREE", repo);

      expect(await getRepositoryRoot(outside)).toBe(repo.replace(/\\/g, "/"));
    } finally {
      await removeTempDir(repo);
      await removeTempDir(outside);
    }
  });

  it("strips unsafe inherited Git configuration while retaining safe local settings", async () => {
    const repo = await createTempDir("abb-git-config-env-");
    try {
      initGitRepo(repo);
      vi.stubEnv("GIT_CONFIG_COUNT", "1");
      vi.stubEnv("GIT_CONFIG_KEY_0", "abb.environment-probe");
      vi.stubEnv("GIT_CONFIG_VALUE_0", "must-not-inherit");
      const git = createGit(repo);
      expect(await git.raw(["config", "--list"])).not.toContain("abb.environment-probe");
      await expect(git.raw(["rev-parse", "--is-inside-work-tree"])).resolves.toBe("true\n");
    } finally {
      await removeTempDir(repo);
    }
  });
});
