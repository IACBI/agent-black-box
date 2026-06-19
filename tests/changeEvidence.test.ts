import { describe, expect, it } from "vitest";
import { buildChangeEvidence, selectSessionRelevantChanges } from "../src/session/changeEvidence.js";
import type { GitSnapshot, SessionBaseline } from "../src/types.js";

const baseline: SessionBaseline = {
  capturedAt: "2026-01-01T00:00:00.000Z",
  git: {
    repoRoot: "/repo",
    head: "aaaa",
    indexFingerprint: "index-a",
    branch: "main",
    statusText: "",
    diffSummaryText: "",
    changedFiles: [
      { path: "src/observed.ts", status: "modified", insertions: 1, deletions: 0 },
      { path: "src/pre-existing.ts", status: "modified", insertions: 1, deletions: 0 }
    ]
  }
};

const finalGit: GitSnapshot = {
  repoRoot: "/repo",
  head: "bbbb",
  indexFingerprint: "index-a",
  branch: "feature",
  statusText: "",
  diffSummaryText: "",
  changedFiles: [
    { path: "src/new.ts", status: "added", insertions: 2, deletions: 0 },
    { path: "src/observed.ts", status: "modified", insertions: 1, deletions: 0 },
    { path: "src/pre-existing.ts", status: "modified", insertions: 1, deletions: 0 }
  ]
};

describe("session change evidence", () => {
  it("separates pre-existing, observed, final-only, and transient paths", () => {
    const evidence = buildChangeEvidence(
      baseline,
      [
        { timestamp: "2026-01-01T00:00:10.000Z", eventType: "change", path: "src/observed.ts" },
        { timestamp: "2026-01-01T00:00:20.000Z", eventType: "add", path: "src/transient.ts" },
        { timestamp: "2026-01-01T00:00:30.000Z", eventType: "unlink", path: "src/transient.ts" }
      ],
      finalGit
    );

    expect(evidence).toMatchObject({ baselineAvailable: true, headChanged: true, indexChanged: false, branchChanged: true });
    expect(evidence.files).toContainEqual({
      path: "src/pre-existing.ts",
      atStart: true,
      observedDuringSession: false,
      atEnd: true,
      gitMetadataChanged: false
    });
    expect(evidence.files).toContainEqual({
      path: "src/transient.ts",
      atStart: false,
      observedDuringSession: true,
      atEnd: false,
      gitMetadataChanged: false
    });
    expect(selectSessionRelevantChanges(finalGit, evidence).map((file) => file.path)).toEqual([
      "src/new.ts",
      "src/observed.ts"
    ]);
  });

  it("keeps all final changes when an older session has no baseline", () => {
    const evidence = buildChangeEvidence(null, [], finalGit);

    expect(evidence.baselineAvailable).toBe(false);
    expect(selectSessionRelevantChanges(finalGit, evidence)).toEqual(finalGit.changedFiles);
  });

  it("keeps all final changes when the Git index changed but per-file watcher evidence is unavailable", () => {
    const evidence = buildChangeEvidence(baseline, [], { ...finalGit, indexFingerprint: "index-b" });

    expect(evidence.indexChanged).toBe(true);
    expect(selectSessionRelevantChanges(finalGit, evidence)).toEqual(finalGit.changedFiles);
  });

  it("keeps changes committed between the start and end HEAD even when the final worktree is clean", () => {
    const cleanFinalGit = { ...finalGit, changedFiles: [] };
    const committedChanges = [{ path: "src/auth.ts", status: "modified" as const }];
    const evidence = buildChangeEvidence(baseline, [], cleanFinalGit, committedChanges);

    expect(selectSessionRelevantChanges(cleanFinalGit, evidence)).toEqual(committedChanges);
  });
});
