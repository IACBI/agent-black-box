import { describe, expect, it } from "vitest";
import {
  buildSessionReport,
  generateCommandsMarkdown,
  generateDiffSummaryMarkdown,
  filterRiskFindings,
  generateRisksMarkdown,
  generateRollbackMarkdown,
  generateSummaryMarkdown,
  generateTimelineMarkdown,
} from "../src/reports/markdown.js";

const baseReport = buildSessionReport(
  {
    id: "session-test",
    repoRoot: "/repo",
    sessionDir: "/repo/.agent-black-box/sessions/session-test",
    startedAt: "2026-01-01T00:00:00.000Z",
  },
  "2026-01-01T00:01:00.000Z",
  "test",
  [{ timestamp: "2026-01-01T00:00:10.000Z", eventType: "change", path: "src/index.ts" }],
  [
    {
      startedAt: "2026-01-01T00:00:20.000Z",
      endedAt: "2026-01-01T00:00:21.000Z",
      command: "pnpm test",
      cwd: ".",
      label: "tests",
      group: "validation",
      phase: "test",
      exitCode: 0,
      durationMs: 1000,
    },
  ],
  {
    repoRoot: "/repo",
    branch: "main",
    statusText: "modified src/index.ts",
    diffSummaryText: "src/index.ts | 2 +",
    changedFiles: [{ path: "src/index.ts", status: "modified", insertions: 2, deletions: 0 }],
  },
  [{ path: "src/config.ts", category: "Config file", severity: "medium", score: 60, reason: "Configuration changed." }],
  [{ path: "src/config.ts", line: 4, reason: "Possible token detected.", redacted: "<redacted>" }],
  {
    warnings: [],
    discardedFileEventLines: 0,
    discardedCommandEventLines: 0,
  },
  {
    capturedAt: "2026-01-01T00:00:00.000Z",
    git: {
      repoRoot: "/repo",
      branch: "main",
      statusText: "Working tree clean for included paths.",
      diffSummaryText: "No tracked Git diff was detected.",
      changedFiles: [],
    },
  }
);

describe("markdown reports", () => {
  it("uses literal Git pathspecs in manual rollback suggestions", () => {
    const markdown = generateRollbackMarkdown(baseReport);
    expect(markdown).toContain("git restore -- ':(top,literal)src/index.ts'");
    expect(markdown).toContain("git diff -- ':(top,literal)src/index.ts'");
  });

  it("generates timeline with command placeholder", () => {
    const markdown = generateTimelineMarkdown(baseReport);

    expect(markdown).toContain("abb run -- <command>");
    expect(markdown).toContain("src/index.ts");
    expect(markdown).toContain("pnpm test");
    expect(markdown).toContain("[tests]");
  });

  it("generates command report", () => {
    const markdown = generateCommandsMarkdown(baseReport);

    expect(markdown).toContain("Recorded commands");
    expect(markdown).toContain("pnpm test");
    expect(markdown).toContain("[tests]");
    expect(markdown).toContain("### validation");
    expect(markdown).toContain("phase `test`");
  });

  it("generates diff summary", () => {
    const markdown = generateDiffSummaryMarkdown(baseReport);

    expect(markdown).toContain("Git status");
    expect(markdown).toContain(
      "| <code>src/index.ts</code> | modified | no | yes | unknown | unknown | 2 | 0 | unknown |  |"
    );
  });

  it("escapes repository-controlled values in diff summary tables", () => {
    const markdown = generateDiffSummaryMarkdown({
      ...baseReport,
      git: {
        ...baseReport.git,
        changedFiles: [
          {
            path: "src/a|`b`.ts",
            status: "modified",
            insertions: 1,
            deletions: 1,
            statsNote: "line one | line two\nnext",
          },
        ],
      },
    });

    expect(markdown).toContain(
      "| <code>src/a&#124;&#96;b&#96;.ts</code> | modified | unknown | unknown | unknown | unknown | 1 | 1 | unknown | line one \\| line two next |"
    );
  });

  it("keeps Git status and diff text inside safe code fences", () => {
    const markdown = generateDiffSummaryMarkdown({
      ...baseReport,
      git: {
        ...baseReport.git,
        statusText: "modified\n```\n# not a heading",
        diffSummaryText: "diff\n````\nnot a fence",
      },
    });

    expect(markdown).toContain("````text\nmodified\n```\n# not a heading\n````");
    expect(markdown).toContain("`````text\ndiff\n````\nnot a fence\n`````");
  });

  it("generates an executive summary", () => {
    const markdown = generateSummaryMarkdown(baseReport);

    expect(markdown).toContain("Agent Black Box Summary");
    expect(markdown).toContain("Final worktree changed files: 1");
    expect(markdown).toContain("Session-relevant repository changes: 1");
    expect(markdown).toContain("Command groups: 1");
    expect(markdown).toContain("Command phases: 1");
    expect(markdown).toContain("Possible secrets: 1");
    expect(markdown).toContain("Risk score:");
    expect(markdown).toContain("Review `risks.md` first");
    expect(markdown).toContain("No malformed session event records");
  });

  it("generates risks without raw secret values", () => {
    const markdown = generateRisksMarkdown(baseReport);

    expect(markdown).toContain("&lt;redacted&gt;");
    expect(markdown).toContain("(60/100)");
    expect(markdown).not.toContain("raw-secret");
  });

  it("filters risk findings by severity and category", () => {
    const risks = [
      ...baseReport.risks,
      { path: ".env", category: "Environment file", severity: "high" as const, score: 90, reason: "Env changed." },
    ];

    expect(filterRiskFindings(risks, { minSeverity: "high" }).map((risk) => risk.path)).toEqual([".env"]);
    expect(filterRiskFindings(risks, { category: "Config file" }).map((risk) => risk.path)).toEqual(["src/config.ts"]);
  });

  it("keeps category filters inside safe inline code", () => {
    const markdown = generateRisksMarkdown(baseReport, { category: "Config`\n# injected\u001b[2J" });

    expect(markdown).toContain("Active filter: category `` Config` # injected [2J ``.");
    expect(markdown).not.toContain("\n# injected");
    expect(markdown).not.toContain("\u001b");
  });

  it("generates rollback suggestions without executing changes", () => {
    const markdown = generateRollbackMarkdown(baseReport);

    expect(markdown).toContain("git diff -- ':(top,literal)src/index.ts'");
    expect(markdown).toContain("git restore -- ':(top,literal)src/index.ts'");
    expect(markdown).toContain("does not automatically revert");
  });

  it("escapes shell-sensitive rollback paths in command previews", () => {
    const markdown = generateRollbackMarkdown({
      ...baseReport,
      git: {
        ...baseReport.git,
        changedFiles: [{ path: "src/weird'$(touch owned)\nfile.ts", status: "modified" }],
      },
    });

    expect(markdown).toContain("abb_arg_1=$(printf '%b_' ':(top,literal)src/weird'\\''$(touch owned)\\0012file.ts')");
    expect(markdown).toContain('git diff -- "${abb_arg_1%_}"');
    expect(markdown).not.toContain("\nfile.ts");
  });

  it("makes control paths visible in rollback headings without emitting terminal escapes", () => {
    const markdown = generateRollbackMarkdown({
      ...baseReport,
      git: {
        ...baseReport.git,
        changedFiles: [{ path: "src/\u001b[2J\nfile.ts", status: "modified" }],
      },
    });
    expect(markdown).not.toContain("\u001b");
    expect(markdown).toContain('### `"src/\\u001b[2J\\nfile.ts"`');
    expect(markdown).toContain("printf '%b_' ':(top,literal)src/\\0033[2J\\0012file.ts'");
  });

  it("keeps control filenames distinct in timeline, summary, risk and diff reports", () => {
    const controlPath = "src/a\u001b[2J\n.ts";
    const literalPath = "src/a\\u001b[2J\\n.ts";
    const report = {
      ...baseReport,
      git: {
        ...baseReport.git,
        changedFiles: [controlPath, literalPath].map((path) => ({ path, status: "modified" as const })),
      },
      events: [controlPath, literalPath].map((path) => ({
        timestamp: baseReport.startedAt,
        eventType: "change" as const,
        path,
      })),
      risks: [controlPath, literalPath].map((path) => ({ ...baseReport.risks[0]!, path })),
    };
    for (const render of [
      generateTimelineMarkdown,
      generateSummaryMarkdown,
      generateRisksMarkdown,
      generateDiffSummaryMarkdown,
    ]) {
      const markdown = render(report);
      expect(markdown).not.toContain("\u001b");
      expect(markdown).toContain(JSON.stringify(controlPath));
      expect(markdown).toContain(JSON.stringify(literalPath));
    }
  });
});
