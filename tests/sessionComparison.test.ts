import { describe, expect, it } from "vitest";
import { generateSessionComparisonMarkdown } from "../src/reports/comparison.js";
import { buildSessionReport } from "../src/reports/markdown.js";
import { buildSessionComparison } from "../src/session/sessionComparison.js";
import type { ChangedFile, CommandEvent, RiskFinding } from "../src/types.js";

describe("session comparison", () => {
  it("compares possible-secret locations and duplicate counts without copying excerpts or extension fields", () => {
    const from = makeReport("session-from", "2026-01-01T00:00:00.000Z", [], [], [], undefined, undefined);
    const to = makeReport("session-to", "2026-01-02T00:00:00.000Z", [], [], [], undefined, undefined);
    const finding = {
      path: "src/a|b.ts",
      line: 3,
      reason: "Token pattern",
      redacted: "PRIVATE EXCERPT",
      extra: "PRIVATE EXTRA",
    };
    from.possibleSecrets = [finding, finding, { ...finding, path: "removed.ts" }];
    to.possibleSecrets = [
      { ...finding, redacted: "OTHER PRIVATE EXCERPT" },
      { ...finding, line: 4 },
    ];
    const comparison = buildSessionComparison(from, to);
    expect(comparison.secrets).toMatchObject({ fromCount: 3, toCount: 2, countDelta: -1 });
    expect(comparison.secrets!.onlyInFrom).toEqual([{ path: "removed.ts", line: 3, reason: "Token pattern" }]);
    expect(comparison.secrets!.onlyInTo).toEqual([{ path: "src/a|b.ts", line: 4, reason: "Token pattern" }]);
    expect(comparison.secrets!.changedCounts).toContainEqual({
      path: "src/a|b.ts",
      line: 3,
      reason: "Token pattern",
      fromCount: 2,
      toCount: 1,
    });
    const markdown = generateSessionComparisonMarkdown(comparison);
    expect(markdown).toContain("src/a&#124;b.ts");
    expect(JSON.stringify(comparison)).not.toContain("PRIVATE");
    expect(markdown).not.toContain("PRIVATE");
    delete comparison.secrets;
    expect(generateSessionComparisonMarkdown(comparison)).not.toContain("Possible-secret location comparison");
  });

  it("compares files, risks, command frequencies, and HEAD revisions", () => {
    const from = makeReport(
      "session-from",
      "2026-01-01T00:00:00.000Z",
      [
        { path: "src/from.ts", status: "modified" },
        { path: "src/shared|unsafe.ts", status: "modified" },
      ],
      [{ path: "config/app.yml", category: "Config file", severity: "medium", score: 60, reason: "Config changed." }],
      [command("pnpm test", 0)],
      "a".repeat(40),
      "b".repeat(40)
    );
    const to = makeReport(
      "session-to",
      "2026-01-02T00:00:00.000Z",
      [
        { path: "src/to.ts", status: "added" },
        { path: "src/shared|unsafe.ts", status: "deleted" },
      ],
      [{ path: ".env", category: "Environment file", severity: "high", score: 93, reason: "Possible secret\nreview." }],
      [command("pnpm test", 0), command("pnpm test", 0), command("pnpm build | tee out", 1)],
      "b".repeat(40),
      "c".repeat(40)
    );

    const comparison = buildSessionComparison(from, to);

    expect(comparison.files.onlyInFrom.map((file) => file.path)).toEqual(["src/from.ts"]);
    expect(comparison.files.onlyInTo.map((file) => file.path)).toEqual(["src/to.ts"]);
    expect(comparison.files.changed).toEqual([
      {
        path: "src/shared|unsafe.ts",
        from: { path: "src/shared|unsafe.ts", status: "modified" },
        to: { path: "src/shared|unsafe.ts", status: "deleted" },
      },
    ]);
    expect(comparison.risks.scoreDelta).toBe(33);
    expect(comparison.commands).toMatchObject({ fromCount: 1, toCount: 3, countDelta: 2, toFailedCount: 1 });
    expect(comparison.commands.changedCounts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ command: "pnpm test", fromCount: 1, toCount: 2 }),
        expect.objectContaining({ command: "pnpm build | tee out", fromCount: 0, toCount: 1 }),
      ])
    );
    expect(comparison.heads).toMatchObject({ fromEnd: "b".repeat(40), toStart: "b".repeat(40), sameEndHead: false });

    const markdown = generateSessionComparisonMarkdown(comparison);
    expect(markdown).toContain("Agent Black Box Session Comparison");
    expect(markdown).toContain("src/shared&#124;unsafe.ts");
    expect(markdown).toContain("pnpm build &#124; tee out");
    expect(markdown).not.toContain("Possible secret\nreview");
    expect(markdown).toContain("Possible secret review.");
  });

  it("rejects comparing a session with itself", () => {
    const report = makeReport("session-same", "2026-01-01T00:00:00.000Z", [], [], [], undefined, undefined);
    expect(() => buildSessionComparison(report, report)).toThrow("two different sessions");
  });

  it("counts startup failures and interrupted commands without exit codes as failed", () => {
    const from = makeReport(
      "session-from",
      "2026-01-01T00:00:00.000Z",
      [],
      [],
      [command("test", 0), command("build", 1), { ...command("missing-tool", null), error: "ENOENT" }],
      undefined,
      undefined
    );
    const to = makeReport(
      "session-to",
      "2026-01-02T00:00:00.000Z",
      [],
      [],
      [command("interrupted-build", null), command("test", 0)],
      undefined,
      undefined
    );

    const comparison = buildSessionComparison(from, to);

    expect(comparison.commands).toMatchObject({ fromFailedCount: 2, toFailedCount: 1 });
    expect(generateSessionComparisonMarkdown(comparison)).toContain("Failed commands: 2 from, 1 to");
  });

  it("renders distinct escaped filenames and working directories without changing comparison values", () => {
    const paths = ["src/a\n.ts", "src/a\\n.ts"];
    const from = makeReport("session-from", "2026-01-01T00:00:00.000Z", [], [], [], undefined, undefined);
    const to = makeReport(
      "session-to",
      "2026-01-02T00:00:00.000Z",
      paths.map((path) => ({ path, status: "modified" })),
      paths.map((path) => ({ path, severity: "low", category: "test", score: 1, reason: "test" })),
      paths.map((cwd) => ({ ...command("test", 0), cwd })),
      undefined,
      undefined
    );
    const comparison = buildSessionComparison(from, to);
    const before = JSON.stringify(comparison);
    const markdown = generateSessionComparisonMarkdown(comparison);
    for (const path of paths) {
      expect(markdown).toContain(JSON.stringify(path));
    }
    expect(comparison.files.onlyInTo.map((file) => file.path)).toEqual(paths);
    expect(comparison.commands.changedCounts.map((entry) => entry.cwd)).toEqual(paths);
    expect(JSON.stringify(comparison)).toBe(before);
  });
});

function makeReport(
  id: string,
  startedAt: string,
  changedFiles: ChangedFile[],
  risks: RiskFinding[],
  commands: CommandEvent[],
  startHead: string | undefined,
  endHead: string | undefined
) {
  return buildSessionReport(
    { id, repoRoot: "/repo", sessionDir: `/repo/.agent-black-box/sessions/${id}`, startedAt },
    new Date(Date.parse(startedAt) + 60_000).toISOString(),
    "test",
    [],
    commands,
    {
      repoRoot: "/repo",
      ...(endHead ? { head: endHead } : {}),
      branch: "main",
      statusText: "test",
      diffSummaryText: "test",
      changedFiles,
    },
    risks,
    [],
    undefined,
    {
      capturedAt: startedAt,
      git: {
        repoRoot: "/repo",
        ...(startHead ? { head: startHead } : {}),
        branch: "main",
        statusText: "Working tree clean for included paths.",
        diffSummaryText: "No tracked Git diff was detected.",
        changedFiles: [],
      },
    }
  );
}

function command(commandText: string, exitCode: number | null): CommandEvent {
  return {
    startedAt: "2026-01-01T00:00:10.000Z",
    endedAt: "2026-01-01T00:00:11.000Z",
    command: commandText,
    cwd: ".",
    exitCode,
    durationMs: 1000,
  };
}
