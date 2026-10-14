import { execFileSync } from "node:child_process";
import { copyFile, mkdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG } from "../src/config/defaults.js";
import { createGit, gitProcessEnvironment } from "../src/git/executable.js";
import { getRepositoryRoot } from "../src/git/git.js";
import { collectBaselineAnalysisInputFiles, collectStagedAnalysisInputFiles } from "../src/analyze/staged.js";
import { analyzeChangedFiles } from "../src/analyze/analyzer.js";
import { compareAnalysisWithBaseline } from "../src/analyze/baseline.js";
import { evaluateAnalysisPolicy } from "../src/analyze/policy.js";
import { summarizeAnalysisCoverage } from "../src/analyze/worktree.js";
import { createTempDir, initGitRepo, removeTempDir } from "./testUtils.js";

describe("Git environment compatibility", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("removes inherited pathspec modes while retaining repository storage settings", () => {
    expect(
      gitProcessEnvironment({
        PATH: "/bin",
        GIT_DIR: "/repo/.git",
        GIT_INDEX_FILE: "/index",
        GIT_LITERAL_PATHSPECS: "1",
        GIT_GLOB_PATHSPECS: "1",
        GIT_NOGLOB_PATHSPECS: "1",
        GIT_ICASE_PATHSPECS: "1",
        git_literal_pathspecs: "1",
      })
    ).toEqual({ PATH: "/bin", GIT_DIR: "/repo/.git", GIT_INDEX_FILE: "/index" });
  });

  it.each(["GIT_LITERAL_PATHSPECS", "GIT_GLOB_PATHSPECS", "GIT_NOGLOB_PATHSPECS", "GIT_ICASE_PATHSPECS"])(
    "preserves staged secret policies and literal baseline paths with inherited %s",
    async (name) => {
      const repo = await createTempDir("abb-git-pathspec-");
      const existing = "PASSWORD=synthetic_old_credential\n";
      const introduced = "PASSWORD=synthetic_new_credential\n";
      try {
        initGitRepo(repo);
        await mkdir(path.join(repo, "node_modules"));
        await writeFile(path.join(repo, "literal[1].ts"), existing);
        await writeFile(path.join(repo, "node_modules", "ignored.txt"), "ordinary\n");
        execFileSync("git", ["add", "."], { cwd: repo });
        execFileSync(
          "git",
          ["-c", "user.name=Audit", "-c", "user.email=audit@example.invalid", "commit", "-qm", "baseline"],
          { cwd: repo }
        );
        const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
        await writeFile(path.join(repo, "literal[1].ts"), existing + introduced);
        await writeFile(path.join(repo, "node_modules", "ignored.txt"), introduced);
        execFileSync("git", ["add", "."], { cwd: repo });
        vi.stubEnv(name, "1");

        const staged = await collectStagedAnalysisInputFiles(repo, DEFAULT_CONFIG);
        expect(staged.map((file) => file.path)).toEqual(["literal[1].ts"]);
        const baseline = await collectBaselineAnalysisInputFiles(repo, staged, DEFAULT_CONFIG, commit);
        expect(baseline[0]?.content).toBe(existing);
        const current = { ...analyzeChangedFiles(staged), coverage: summarizeAnalysisCoverage(staged, "index") };
        const compared = compareAnalysisWithBaseline(staged, baseline, current, commit);

        expect(compared.baselineComparison?.suppressedExistingSecrets).toBe(1);
        expect(evaluateAnalysisPolicy(compared, staged, "complete-review")).toMatchObject({
          failed: true,
          newSecretCount: 1,
          skippedStagedFiles: 0,
          skippedBaselineFiles: 0,
        });
        expect(JSON.stringify(compared)).not.toContain("synthetic_old_credential");
        expect(JSON.stringify(compared)).not.toContain("synthetic_new_credential");
      } finally {
        await removeTempDir(repo);
      }
    }
  );

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

      expect(await getRepositoryRoot(outside)).toBe((await realpath(repo)).replace(/\\/g, "/"));
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
