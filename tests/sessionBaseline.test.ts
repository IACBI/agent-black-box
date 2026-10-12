import { execFileSync } from "node:child_process";
import { open, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG } from "../src/config/defaults.js";
import * as git from "../src/git/git.js";
import { createRollbackPlan } from "../src/rollback/rollback.js";
import { readCatalogSessionReport } from "../src/session/sessionCatalog.js";
import {
  createSession,
  finalizeSession,
  getActiveSessionPath,
  getGitBaselinePath,
  getSessionLockPath,
  readActiveSessionState,
  readSessionBaseline,
  readSessionLockState,
} from "../src/session/sessionManager.js";
import type { GitSnapshot } from "../src/types.js";
import { pathExists } from "../src/utils/files.js";
import { createTempDir, initGitRepo, removeTempDir } from "./testUtils.js";

function runGit(repo: string, args: string[], input?: string): string {
  return execFileSync("git", args, { cwd: repo, input, encoding: "utf8" }).trim();
}

async function createSizedFile(filePath: string, bytes: number): Promise<void> {
  const handle = await open(filePath, "w");
  try {
    await handle.truncate(bytes);
  } finally {
    await handle.close();
  }
}

describe("session Git baseline storage", () => {
  it("preserves a large dirty checkout through finalization, rollback planning, and reopening", async () => {
    const repo = await createTempDir("abb-baseline-");
    try {
      initGitRepo(repo);
      const original = "original\n";
      const blob = runGit(repo, ["hash-object", "-w", "--stdin"], original);
      const deletedPaths = Array.from(
        { length: 6_000 },
        (_, index) => `deleted-${String(index).padStart(6, "0")}-${"x".repeat(154)}.txt`
      );
      // Populate the real index directly: these absent tracked files model a mass deletion without
      // creating thousands of filesystem fixtures. Only fresh.txt is clean at session start.
      runGit(
        repo,
        ["update-index", "--index-info"],
        [...deletedPaths, "fresh.txt"].map((filePath) => `100644 ${blob}\t${filePath}\n`).join("")
      );
      runGit(repo, ["-c", "user.name=Tests", "-c", "user.email=tests@example.invalid", "commit", "-qm", "baseline"]);
      await writeFile(path.join(repo, "fresh.txt"), original);

      const session = await createSession(repo, DEFAULT_CONFIG);
      const baselinePath = getGitBaselinePath(session.sessionDir);
      expect((await stat(baselinePath)).size).toBeGreaterThan(1024 * 1024);
      const baseline = await readSessionBaseline(session.sessionDir);
      expect(baseline).not.toBeNull();
      expect(baseline?.git.changedFiles).toHaveLength(deletedPaths.length);
      expect(Buffer.byteLength(baseline?.git.statusText ?? "")).toBeGreaterThan(1024 * 1024);

      await writeFile(path.join(repo, "fresh.txt"), "changed during session\n");
      const report = await finalizeSession(session, DEFAULT_CONFIG, "test");
      expect(report.changeEvidence.baselineAvailable).toBe(true);
      const evidence = new Map(report.changeEvidence.files.map((file) => [file.path, file]));
      expect(evidence.get(deletedPaths[0]!)).toMatchObject({ atStart: true, atEnd: true });
      expect(evidence.get("fresh.txt")).toMatchObject({ atStart: false, atEnd: true });
      expect(report.integrity.warnings.some((warning) => warning.includes("Git start baseline"))).toBe(false);
      const plan = createRollbackPlan(report);
      expect(plan.restorableFiles.map((file) => file.path)).toEqual(["fresh.txt"]);
      expect(plan.skippedFiles).toHaveLength(deletedPaths.length);
      expect(plan.skippedFiles[0]?.reason).toContain("already had changes at session start");

      const reopened = await readCatalogSessionReport({
        id: session.id,
        sessionDir: session.sessionDir,
        state: "complete",
      });
      expect(reopened.baseline?.git.changedFiles).toHaveLength(deletedPaths.length);
      expect(reopened.changeEvidence.baselineAvailable).toBe(true);
      expect(createRollbackPlan(reopened).restorableFiles.map((file) => file.path)).toEqual(["fresh.txt"]);
      expect(await readFile(path.join(repo, "fresh.txt"), "utf8")).toBe("changed during session\n");
      expect(await pathExists(path.join(repo, deletedPaths[0]!))).toBe(false);
    } finally {
      await removeTempDir(repo);
    }
  }, 30_000);

  it("refuses an oversized stored baseline without reading it as valid evidence", async () => {
    const repo = await createTempDir("abb-baseline-limit-");
    try {
      initGitRepo(repo);
      const session = await createSession(repo, DEFAULT_CONFIG);
      await createSizedFile(getGitBaselinePath(session.sessionDir), 32 * 1024 * 1024 + 1);

      await expect(readSessionBaseline(session.sessionDir)).resolves.toBeNull();
      const report = await finalizeSession(session, DEFAULT_CONFIG, "test");
      expect(report.changeEvidence.baselineAvailable).toBe(false);
      expect(report.integrity.warnings.join("\n")).toContain("git-start.json exceeds the 32 MiB size limit");
    } finally {
      await removeTempDir(repo);
    }
  });

  it.each(["active", "lock"])("keeps the %s ownership read limit at 1 MiB", async (kind) => {
    const repo = await createTempDir("abb-state-limit-");
    try {
      initGitRepo(repo);
      await createSession(repo, DEFAULT_CONFIG);
      const statePath =
        kind === "active" ? getActiveSessionPath(repo, DEFAULT_CONFIG) : getSessionLockPath(repo, DEFAULT_CONFIG);
      await createSizedFile(statePath, 1024 * 1024 + 1);

      const state =
        kind === "active"
          ? await readActiveSessionState(repo, DEFAULT_CONFIG)
          : await readSessionLockState(repo, DEFAULT_CONFIG);
      expect(state).toMatchObject({ value: null, corrupted: true });
      expect(state.error).toContain("1 MiB size limit");
      expect((await stat(statePath)).size).toBe(1024 * 1024 + 1);
    } finally {
      await removeTempDir(repo);
    }
  });

  it.each(["oversized", "invalid"])("rejects an %s Git snapshot before publishing session state", async (kind) => {
    const repo = await createTempDir("abb-baseline-publication-");
    const collect = vi.spyOn(git, "collectGitSnapshot");
    try {
      initGitRepo(repo);
      const snapshot: GitSnapshot = {
        repoRoot: repo,
        statusText: kind === "oversized" ? "é".repeat(16 * 1024 * 1024) : "Working tree clean.",
        diffSummaryText: "No tracked Git diff.",
        changedFiles: [],
        ...(kind === "invalid" ? { branch: "x".repeat(1025) } : {}),
      };
      collect.mockResolvedValueOnce(snapshot);

      await expect(createSession(repo, DEFAULT_CONFIG)).rejects.toThrow(
        kind === "oversized"
          ? "32 MiB size limit; session was not started"
          : "unsupported shape; session was not started"
      );
      expect(await readdir(repo)).toEqual([".git"]);
      expect(await pathExists(getActiveSessionPath(repo, DEFAULT_CONFIG))).toBe(false);
      expect(await pathExists(getSessionLockPath(repo, DEFAULT_CONFIG))).toBe(false);
    } finally {
      collect.mockRestore();
      await removeTempDir(repo);
    }
  });
});
