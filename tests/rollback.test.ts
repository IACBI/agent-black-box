import { execFileSync } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/config/defaults.js";
import { collectGitSnapshot } from "../src/git/git.js";
import {
  applyRollbackPlan,
  applyVerifiedRollbackPlan,
  createRollbackPlan,
  getConfirmationText,
  renderRollbackPlan,
  toLiteralGitPathspec,
  verifyRollbackSafetyState,
  writeRollbackSafetyState,
} from "../src/rollback/rollback.js";
import type { SessionReport } from "../src/types.js";
import { createTempDir, initGitRepo, removeTempDir } from "./testUtils.js";

const report = {
  id: "session-test",
  repoRoot: "/repo",
  sessionDir: "/repo/.agent-black-box/sessions/session-test",
  startedAt: "2026-01-01T00:00:00.000Z",
  endedAt: "2026-01-01T00:01:00.000Z",
  finalizedBy: "test",
  commandCapture: {
    implemented: true,
    mode: "wrapper-only",
    note: "test",
  },
  events: [],
  commands: [],
  git: {
    repoRoot: "/repo",
    statusText: "",
    diffSummaryText: "",
    changedFiles: [
      { path: "src/index.ts", status: "modified" },
      { path: "README.md", status: "added" },
      { path: "src/old.ts", status: "deleted" },
      { path: "src/pre-existing.ts", status: "modified" },
    ],
  },
  baseline: {
    capturedAt: "2026-01-01T00:00:00.000Z",
    git: {
      repoRoot: "/repo",
      statusText: "modified src/pre-existing.ts",
      diffSummaryText: "",
      changedFiles: [{ path: "src/pre-existing.ts", status: "modified" }],
    },
  },
  changeEvidence: {
    baselineAvailable: true,
    baselineCapturedAt: "2026-01-01T00:00:00.000Z",
    headChanged: false,
    indexChanged: false,
    branchChanged: false,
    committedChanges: [],
    files: [
      { path: "src/index.ts", atStart: false, observedDuringSession: true, atEnd: true, gitMetadataChanged: true },
      { path: "README.md", atStart: false, observedDuringSession: true, atEnd: true, gitMetadataChanged: true },
      { path: "src/old.ts", atStart: false, observedDuringSession: true, atEnd: true, gitMetadataChanged: true },
      {
        path: "src/pre-existing.ts",
        atStart: true,
        observedDuringSession: false,
        atEnd: true,
        gitMetadataChanged: false,
      },
    ],
  },
  risks: [],
  riskSummary: {
    score: 0,
    maxSeverity: "none",
    possibleSecretCount: 0,
    severityCounts: {
      low: 0,
      medium: 0,
      high: 0,
    },
  },
  possibleSecrets: [],
  integrity: {
    warnings: [],
    discardedFileEventLines: 0,
    discardedCommandEventLines: 0,
  },
} satisfies SessionReport;

describe("rollback planner", () => {
  it("plans only tracked modified and deleted files for automatic restore", () => {
    const plan = createRollbackPlan(report);

    expect(plan.restorableFiles.map((file) => file.path)).toEqual(["src/index.ts", "src/old.ts"]);
    expect(plan.skippedFiles).toEqual([
      {
        path: "README.md",
        reason: "Added or untracked files are not removed automatically.",
      },
      {
        path: "src/pre-existing.ts",
        reason: "File already had changes at session start; restoring to HEAD could discard pre-session work.",
      },
    ]);
    expect(getConfirmationText(plan)).toBe("RESTORE 2 files");
  });

  it("limits the plan to requested files and reports missing paths", () => {
    const plan = createRollbackPlan(report, ["README.md", "missing.ts"]);

    expect(plan.restorableFiles).toEqual([]);
    expect(renderRollbackPlan(plan)).toContain("missing.ts");
    expect(renderRollbackPlan(plan)).toContain("not present");
  });

  it("converts report paths to literal top-level Git pathspecs", () => {
    expect(toLiteralGitPathspec("src/[special]*.ts")).toBe(":(top,literal)src/[special]*.ts");
    expect(toLiteralGitPathspec("src\\index.ts")).toBe(":(top,literal)src/index.ts");
  });

  it("uses literal pathspecs in the copyable restore preview", () => {
    const preview = renderRollbackPlan({
      requestedFiles: [],
      restorableFiles: [{ path: "src/[special].ts", status: "modified" }],
      skippedFiles: [],
    });
    expect(preview).toContain("-- ':(top,literal)src/[special].ts'");
  });

  it("applies a literal rollback pathspec to the intended tracked file", async () => {
    const repo = await createTempDir("abb-rollback-");
    try {
      initGitRepo(repo);
      execFileSync("git", ["config", "user.email", "tests@example.invalid"], { cwd: repo });
      execFileSync("git", ["config", "user.name", "Agent Black Box Tests"], { cwd: repo });
      const filePath = path.join(repo, "src", "index.txt");
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, "original\n", "utf8");
      execFileSync("git", ["add", "."], { cwd: repo });
      execFileSync("git", ["commit", "-m", "initial"], { cwd: repo });
      await writeFile(filePath, "changed\n", "utf8");

      await applyRollbackPlan(repo, {
        requestedFiles: [],
        restorableFiles: [{ path: "src/index.txt", status: "modified" }],
        skippedFiles: [],
      });

      const restored = await readFile(filePath, "utf8");
      expect(restored.replace(/\r\n/g, "\n")).toBe("original\n");
    } finally {
      await removeTempDir(repo);
    }
  });

  it("refuses automatic restore when file contents changed after the session", async () => {
    const repo = await createTempDir("abb-rollback-safety-");
    try {
      initGitRepo(repo);
      execFileSync("git", ["config", "user.email", "tests@example.invalid"], { cwd: repo });
      execFileSync("git", ["config", "user.name", "Agent Black Box Tests"], { cwd: repo });
      const filePath = path.join(repo, "src", "index.txt");
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, "original\n", "utf8");
      execFileSync("git", ["add", "."], { cwd: repo });
      execFileSync("git", ["commit", "-m", "initial"], { cwd: repo });
      await writeFile(filePath, "changed!\n", "utf8");

      const sessionDir = path.join(repo, ".agent-black-box", "sessions", "session-test");
      await mkdir(sessionDir, { recursive: true });
      const sessionReport: SessionReport = {
        ...report,
        repoRoot: repo,
        sessionDir,
        git: await collectGitSnapshot(repo, DEFAULT_CONFIG.exclude),
        changeEvidence: {
          ...report.changeEvidence,
          files: [
            {
              path: "src/index.txt",
              atStart: false,
              observedDuringSession: true,
              atEnd: true,
              gitMetadataChanged: true,
            },
          ],
        },
      };
      const plan = createRollbackPlan(sessionReport);
      expect(plan.restorableFiles.map((file) => file.path)).toEqual(["src/index.txt"]);
      await writeRollbackSafetyState(sessionReport);
      await expect(
        verifyRollbackSafetyState(repo, sessionDir, sessionReport, plan, DEFAULT_CONFIG)
      ).resolves.toBeUndefined();

      await applyVerifiedRollbackPlan(repo, sessionDir, sessionReport, plan, DEFAULT_CONFIG);
      expect((await readFile(filePath, "utf8")).replace(/\r\n/g, "\n")).toBe("original\n");
      await writeFile(filePath, "changed!\n", "utf8");

      await writeFile(path.join(repo, "other.txt"), "new staged file\n", "utf8");
      execFileSync("git", ["add", "other.txt"], { cwd: repo });
      await expect(verifyRollbackSafetyState(repo, sessionDir, sessionReport, plan, DEFAULT_CONFIG)).rejects.toThrow(
        "HEAD or staged changes differ"
      );
      execFileSync("git", ["reset", "-q", "HEAD", "--", "other.txt"], { cwd: repo });

      await writeFile(filePath, "swapped!\n", "utf8");
      await expect(verifyRollbackSafetyState(repo, sessionDir, sessionReport, plan, DEFAULT_CONFIG)).rejects.toThrow(
        "changed since the session"
      );
      await expect(applyVerifiedRollbackPlan(repo, sessionDir, sessionReport, plan, DEFAULT_CONFIG)).rejects.toThrow(
        "changed since the session"
      );
      expect(await readFile(filePath, "utf8")).toBe("swapped!\n");

      await rm(path.join(sessionDir, "rollback-state.json"));
      await expect(verifyRollbackSafetyState(repo, sessionDir, sessionReport, plan, DEFAULT_CONFIG)).rejects.toThrow(
        "no readable rollback safety snapshot"
      );
    } finally {
      await removeTempDir(repo);
    }
  }, 15_000);
});
