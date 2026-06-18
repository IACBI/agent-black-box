import { describe, expect, it } from "vitest";
import { createRollbackPlan, getConfirmationText, renderRollbackPlan } from "../src/rollback/rollback.js";
import type { SessionReport } from "../src/types.js";

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
    note: "test"
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
      { path: "src/old.ts", status: "deleted" }
    ]
  },
  risks: [],
  possibleSecrets: []
} satisfies SessionReport;

describe("rollback planner", () => {
  it("plans only tracked modified and deleted files for automatic restore", () => {
    const plan = createRollbackPlan(report);

    expect(plan.restorableFiles.map((file) => file.path)).toEqual(["src/index.ts", "src/old.ts"]);
    expect(plan.skippedFiles).toEqual([
      {
        path: "README.md",
        reason: "Added or untracked files are not removed automatically."
      }
    ]);
    expect(getConfirmationText(plan)).toBe("RESTORE 2 files");
  });

  it("limits the plan to requested files and reports missing paths", () => {
    const plan = createRollbackPlan(report, ["README.md", "missing.ts"]);

    expect(plan.restorableFiles).toEqual([]);
    expect(renderRollbackPlan(plan)).toContain("missing.ts");
    expect(renderRollbackPlan(plan)).toContain("not present");
  });
});
