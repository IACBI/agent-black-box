import { describe, expect, it } from "vitest";
import {
  buildSessionReport,
  generateDiffSummaryMarkdown,
  generateRisksMarkdown,
  generateRollbackMarkdown,
  generateTimelineMarkdown
} from "../src/reports/markdown.js";

const baseReport = buildSessionReport(
  {
    id: "session-test",
    repoRoot: "/repo",
    sessionDir: "/repo/.agent-black-box/sessions/session-test",
    startedAt: "2026-01-01T00:00:00.000Z"
  },
  "2026-01-01T00:01:00.000Z",
  "test",
  [{ timestamp: "2026-01-01T00:00:10.000Z", eventType: "change", path: "src/index.ts" }],
  [
    {
      startedAt: "2026-01-01T00:00:20.000Z",
      endedAt: "2026-01-01T00:00:21.000Z",
      command: "pnpm test",
      cwd: "/repo",
      exitCode: 0,
      durationMs: 1000
    }
  ],
  {
    repoRoot: "/repo",
    branch: "main",
    statusText: "modified src/index.ts",
    diffSummaryText: "src/index.ts | 2 +",
    changedFiles: [{ path: "src/index.ts", status: "modified", insertions: 2, deletions: 0 }]
  },
  [{ path: "src/config.ts", category: "Config file", severity: "medium", reason: "Configuration changed." }],
  [{ path: "src/config.ts", line: 4, reason: "Possible token detected.", redacted: "<redacted>" }]
);

describe("markdown reports", () => {
  it("generates timeline with command placeholder", () => {
    const markdown = generateTimelineMarkdown(baseReport);

    expect(markdown).toContain("abb run -- <command>");
    expect(markdown).toContain("src/index.ts");
    expect(markdown).toContain("pnpm test");
  });

  it("generates diff summary", () => {
    const markdown = generateDiffSummaryMarkdown(baseReport);

    expect(markdown).toContain("Git status");
    expect(markdown).toContain("| `src/index.ts` | modified | 2 | 0 |");
  });

  it("generates risks without raw secret values", () => {
    const markdown = generateRisksMarkdown(baseReport);

    expect(markdown).toContain("<redacted>");
    expect(markdown).not.toContain("raw-secret");
  });

  it("generates rollback suggestions without executing changes", () => {
    const markdown = generateRollbackMarkdown(baseReport);

    expect(markdown).toContain("git diff -- \"src/index.ts\"");
    expect(markdown).toContain("git restore -- \"src/index.ts\"");
    expect(markdown).toContain("does not automatically revert");
  });
});
