import { describe, expect, it } from "vitest";
import { generatePullRequestComment } from "../src/reports/prComment.js";
import type { ChangedFile, CommandEvent, RiskFinding, SecretFinding, SessionReport } from "../src/types.js";

const MARKER = "<!-- agent-black-box:session-summary -->";
const PLANTED_VALUE = "ghp_PLANTEDsecretVALUE0123456789abcdef";
const START_HEAD = "aaaaaaa1111111111111111111111111111111aa";
const END_HEAD = "bbbbbbb2222222222222222222222222222222bb";
const SESSION_ID = "session-2026-01-01T00-00-00-000Z-1a2b3c4d-0000-4000-8000-000000000000";

interface FixtureOptions {
  risks?: RiskFinding[];
  secrets?: SecretFinding[];
  commands?: CommandEvent[];
  changedPaths?: string[];
  integrity?: Partial<SessionReport["integrity"]>;
  branch?: string;
  heads?: boolean;
}

function risk(overrides: Partial<RiskFinding> = {}): RiskFinding {
  return {
    path: "src/config.ts",
    category: "Config file",
    severity: "medium",
    score: 50,
    reason: "Configuration changed.",
    ...overrides,
  };
}

function command(overrides: Partial<CommandEvent> = {}): CommandEvent {
  return {
    startedAt: "2026-01-01T00:00:10.000Z",
    endedAt: "2026-01-01T00:00:11.000Z",
    command: "pnpm test",
    cwd: ".",
    exitCode: 0,
    durationMs: 1500,
    ...overrides,
  };
}

function makeReport(options: FixtureOptions = {}): SessionReport {
  const risks = options.risks ?? [];
  const secrets = options.secrets ?? [];
  const changedFiles: ChangedFile[] = (options.changedPaths ?? []).map((path) => ({ path, status: "modified" }));
  const heads = options.heads ?? true;
  return {
    id: SESSION_ID,
    repoRoot: "/repo",
    sessionDir: "/repo/.agent-black-box/sessions/x",
    startedAt: "2026-01-01T00:00:00.000Z",
    endedAt: "2026-01-01T00:05:00.000Z",
    finalizedBy: "test",
    commandCapture: { implemented: true, mode: "wrapper-only", note: "note" },
    events: [],
    commands: options.commands ?? [],
    baseline: heads
      ? {
          capturedAt: "2026-01-01T00:00:00.000Z",
          git: { repoRoot: "/repo", head: START_HEAD, statusText: "", diffSummaryText: "", changedFiles: [] },
        }
      : null,
    changeEvidence: {
      baselineAvailable: heads,
      headChanged: null,
      indexChanged: false,
      branchChanged: null,
      committedChanges: [],
      files: changedFiles.map((file) => ({
        path: file.path,
        atStart: false,
        observedDuringSession: true,
        atEnd: true,
        gitMetadataChanged: null,
      })),
    },
    git: {
      repoRoot: "/repo",
      branch: options.branch ?? "feature/pr-comment",
      ...(heads ? { head: END_HEAD } : {}),
      statusText: "",
      diffSummaryText: "",
      changedFiles,
    },
    risks,
    riskSummary: {
      score: 0,
      maxSeverity: "none",
      possibleSecretCount: secrets.length,
      severityCounts: { high: 0, medium: 0, low: 0 },
    },
    possibleSecrets: secrets,
    integrity: { warnings: [], discardedFileEventLines: 0, discardedCommandEventLines: 0, ...options.integrity },
  };
}

function fullFixture(): SessionReport {
  return makeReport({
    risks: [
      risk({ path: "src/low.ts", severity: "low", score: 10, category: "Docs", reason: "Docs changed." }),
      risk({ path: ".env", severity: "high", score: 90, category: "Environment file", reason: "Environment changed." }),
      risk({ path: "src/config.ts" }),
      risk({ path: "Dockerfile", severity: "high", score: 70, category: "Docker file", reason: "Docker changed." }),
    ],
    secrets: [
      { path: "src/key.ts", line: 9, reason: "Possible token detected.", redacted: PLANTED_VALUE },
      { path: "src/aws.ts", line: 2, reason: "Possible token detected.", redacted: `${PLANTED_VALUE}-2` },
    ],
    commands: [
      command({ command: "pnpm lint" }),
      command({ command: "pnpm test", exitCode: 1, durationMs: 2500 }),
      command({ command: "pnpm build", exitCode: null }),
    ],
    changedPaths: [".env", "src/config.ts", "src/key.ts"],
  });
}

function section(markdown: string, heading: string): string[] {
  const lines = markdown.split("\n");
  const start = lines.findIndex((line) => line.startsWith(heading));
  expect(start).toBeGreaterThanOrEqual(0);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith("### "));
  return end === -1 ? rest : rest.slice(0, end);
}

function tableLines(input: string | string[]): string[] {
  const markdown = Array.isArray(input) ? input.join("\n") : input;
  return markdown.split("\n").filter((line) => line.startsWith("|"));
}

function unescapedPipes(line: string): number {
  return (line.match(/(?<!\\)\|/g) ?? []).length;
}

function expectWellFormed(output: string, maxLength: number): void {
  expect(output.length).toBeLessThanOrEqual(maxLength);
  expect(output.endsWith("\n")).toBe(true);
  expect((output.match(/<details>/g) ?? []).length).toBe((output.match(/<\/details>/g) ?? []).length);
  let expectedPipes = 0;
  for (const line of tableLines(output)) {
    if (line.startsWith("| Severity")) {
      expectedPipes = 5;
    } else if (line.startsWith("| Command")) {
      expectedPipes = 4;
    }
    expect(line.endsWith("|")).toBe(true);
    expect(unescapedPipes(line)).toBe(expectedPipes);
  }
}

describe("pull request comment", () => {
  it("starts with the stable marker and includes every section", () => {
    const comment = generatePullRequestComment(fullFixture());
    const lines = comment.split("\n");

    expect(lines[0]).toBe(MARKER);
    expect(lines[1]).toBe("## Agent Black Box session `session-2026-01-01T00-00-00-000Z-1a2b3c4d`");
    expect(comment).not.toContain("-0000-4000-8000");
    expect(comment).toContain("Branch `feature/pr-comment` - HEAD `aaaaaaa` to `bbbbbbb`");
    expect(comment).toContain(
      "**Verdict: HIGH** - 2 high, 1 medium, 1 low risks; 2 possible secrets; 3 session-relevant changed files; 3 commands run, 2 failed."
    );
    expect(comment).toContain("### Risks (4)");
    expect(comment).toContain("### Possible secrets (2)");
    expect(comment).toContain("### Commands (3)");
    expect(comment).toContain("<summary>Session-relevant changed files (3)</summary>");
    expect(comment).not.toContain("Integrity / capture warnings");
    expect(comment.endsWith("\n")).toBe(true);
    expect(comment).toContain("Generated locally by Agent Black Box");
    expect(comment).toContain("not a security scan");
  });

  it("lists risks by descending severity and score", () => {
    const rows = tableLines(section(generatePullRequestComment(fullFixture()), "### Risks").join("\n")).slice(2);

    expect(rows.map((row) => row.split(" | ")[0])).toEqual(["| HIGH", "| HIGH", "| MEDIUM", "| LOW"]);
    expect(rows[0]).toContain("<code>.env</code>");
    expect(rows[1]).toContain("<code>Dockerfile</code>");
  });

  it("shows possible secret locations but never their values", () => {
    const comment = generatePullRequestComment(fullFixture());
    const lines = section(comment, "### Possible secrets").filter((line) => line.startsWith("- "));

    expect(lines).toEqual(["- `src/aws.ts:2`", "- `src/key.ts:9`"]);
    expect(comment).not.toContain(PLANTED_VALUE);
    expect(comment).not.toContain("PLANTEDsecret");
  });

  it("marks failed commands and prioritises them when rows are capped", () => {
    const many = Array.from({ length: 20 }, (_, index) => command({ command: `step-${index}` }));
    many[18] = command({ command: "failing-step", exitCode: 2 });
    const comment = generatePullRequestComment(makeReport({ commands: many }));
    const rows = tableLines(comment).slice(2);

    expect(rows).toHaveLength(15);
    expect(rows.some((row) => row.includes("failing-step") && row.includes("2 (failed)"))).toBe(true);
    expect(rows.some((row) => row.includes("step-19"))).toBe(false);
    expect(comment).toContain("+5 more commands not shown.");
    expect(comment).toContain("20 commands run, 1 failed.");
  });

  it("caps the risk table at 15 rows and reports the remainder", () => {
    const risks = Array.from({ length: 22 }, (_, index) =>
      risk({ path: `src/file-${String(index).padStart(2, "0")}.ts`, severity: index < 3 ? "high" : "low" })
    );
    const comment = generatePullRequestComment(makeReport({ risks }));

    expect(tableLines(comment).slice(2)).toHaveLength(15);
    expect(comment).toContain("### Risks (22)");
    expect(comment).toContain("+7 more risks not shown.");
    expect(comment).toContain("file-00.ts");
    expect(comment).not.toContain("file-21.ts");
  });

  it("collapses changed files and reports the overflow", () => {
    const changedPaths = Array.from({ length: 40 }, (_, index) => `src/changed-${index}.ts`);
    const comment = generatePullRequestComment(makeReport({ changedPaths }));

    expect(comment).toContain("<details>\n<summary>Session-relevant changed files (40)</summary>");
    expect(comment).toContain("+10 more files not shown.");
    expect(comment.indexOf("</details>")).toBeGreaterThan(comment.indexOf("+10 more files"));
  });

  it("neutralises hostile paths, commands, reasons and branch names", () => {
    const hostilePath = "src/a|b`c<script>alert(1)</script>\n# Injected heading\u001b[31m\u202E.ts";
    const comment = generatePullRequestComment(
      makeReport({
        branch: "feat/`x`|<b>",
        risks: [
          risk({
            path: hostilePath,
            severity: "high",
            category: "Evil|<i>cat</i>",
            reason: "Changed | **bold** [x](http://evil.example) <b>hi</b>\n# Reason heading @octocat \u202E",
          }),
        ],
        secrets: [{ path: hostilePath, line: 4, reason: "r", redacted: "x" }],
        commands: [command({ command: "echo a|b `x` <img src=x onerror=1>\n# Boom\u001b[2J\u202E", exitCode: 3 })],
        changedPaths: [hostilePath],
      })
    );

    // The zero-width space after "@" is deliberate, so only the other invisible characters are rejected.
    // eslint-disable-next-line no-control-regex -- Asserting that control characters never reach the output.
    expect(comment).not.toMatch(/[\u0000-\u0009\u000B-\u001F\u007F\u200C-\u200F\u202A-\u202E\u2066-\u2069]/);
    // Table cells render HTML, so raw tags must be escaped there; code spans keep their text literal.
    const tables = tableLines(comment).join("\n");
    expect(tables).not.toContain("<script");
    expect(tables).not.toContain("<img");
    expect(tables).not.toContain("<b>hi");
    expect(tables).not.toContain("<i>");
    expect(section(comment, "### Possible secrets")).toContain(
      '- `` "src/a|b`c<script>alert(1)</script>\\n# Injected heading\\u001b[31m<U+202E>.ts:4" ``'
    );
    expect(comment).not.toContain("[x](");
    expect(comment).not.toContain("@octocat");
    expect(comment).toContain("&lt;script&gt;");
    expect(comment).toContain("&lt;U+202E&gt;");
    expect(comment).toContain("`` feat/`x`|<b> ``");

    for (const line of comment.split("\n")) {
      expect(line.startsWith("# ")).toBe(false);
      expect(line.startsWith("## Injected")).toBe(false);
      expect(line.startsWith("# Boom")).toBe(false);
    }

    const riskRows = tableLines(section(comment, "### Risks")).slice(2);
    expect(riskRows).toHaveLength(1);
    expect(unescapedPipes(riskRows[0] as string)).toBe(5);
    const commandRows = tableLines(section(comment, "### Commands")).slice(2);
    expect(commandRows).toHaveLength(1);
    expect(unescapedPipes(commandRows[0] as string)).toBe(4);
  });

  it("surfaces lossy capture prominently", () => {
    const comment = generatePullRequestComment(
      makeReport({
        integrity: {
          warnings: ["Watcher queue overflowed | events lost.", "Second warning."],
          droppedFileEvents: 12,
          failedFileEventWrites: 3,
          discardedFileEventLines: 2,
          discardedCommandEventLines: 1,
        },
      })
    );
    const lines = section(comment, "### Integrity / capture warnings");

    expect(lines.filter((line) => line.startsWith("- "))).toEqual([
      "- Dropped watcher file events: 12",
      "- Failed file event writes: 3",
      "- Discarded file event lines: 2",
      "- Discarded command event lines: 1",
      "- Watcher queue overflowed \\| events lost.",
      "- Second warning.",
    ]);
    expect(comment.indexOf("Integrity / capture warnings")).toBeLessThan(comment.indexOf("No commands were recorded"));
  });

  it("reports a clean session in a few lines", () => {
    const comment = generatePullRequestComment(makeReport());

    expect(comment).toContain("**Verdict: no risks detected** - 0 high, 0 medium, 0 low risks; 0 possible secrets;");
    expect(comment).toContain("No risk signals or possible secrets were detected in this session's changes.");
    expect(comment).toContain("No commands were recorded.");
    expect(comment).not.toContain("### Risks");
    expect(comment).not.toContain("### Possible secrets");
    expect(comment).not.toContain("<details>");
    expect(comment.length).toBeLessThan(1200);
  });

  it("tells the reviewer when the allowlist hid possible secrets", () => {
    const hidden = makeReport();
    hidden.riskSummary = { ...hidden.riskSummary, allowlistedSecretCount: 3 };
    const comment = generatePullRequestComment(hidden);

    expect(comment).toContain("3 possible secrets hidden by the configured allowlist.");
    expect(comment).toContain("No risk signals or unsuppressed possible secrets were detected");
    expect(comment).not.toContain("No risk signals or possible secrets were detected");

    hidden.riskSummary = { ...hidden.riskSummary, allowlistedSecretCount: 1 };
    expect(generatePullRequestComment(hidden)).toContain("1 possible secret hidden by the configured allowlist.");
    expect(generatePullRequestComment(makeReport())).not.toContain("allowlist");
  });

  it("notes when no start baseline is available", () => {
    const comment = generatePullRequestComment(makeReport({ heads: false }));

    expect(comment).toContain("start baseline unavailable");
    expect(comment).not.toContain("HEAD `");
  });

  it("is deterministic and independent of input ordering", () => {
    const report = fullFixture();
    const shuffled: SessionReport = {
      ...report,
      risks: [...report.risks].reverse(),
      possibleSecrets: [...report.possibleSecrets].reverse(),
    };

    expect(generatePullRequestComment(report)).toBe(generatePullRequestComment(fullFixture()));
    expect(generatePullRequestComment(shuffled)).toBe(generatePullRequestComment(report));
  });
});

describe("pull request comment size limit", () => {
  const huge = makeReport({
    risks: Array.from({ length: 300 }, (_, index) =>
      risk({ path: `src/module-${index}/file.ts`, severity: index % 3 === 0 ? "high" : "medium", score: index })
    ),
    secrets: Array.from({ length: 60 }, (_, index) => ({
      path: `src/secret-${index}.ts`,
      line: index + 1,
      reason: "Possible token detected.",
      redacted: PLANTED_VALUE,
    })),
    commands: Array.from({ length: 120 }, (_, index) => command({ command: `pnpm run task-${index}` })),
    changedPaths: Array.from({ length: 300 }, (_, index) => `src/changed/file-${index}.ts`),
    integrity: { warnings: Array.from({ length: 30 }, (_, index) => `Warning number ${index}.`), droppedFileEvents: 5 },
  });

  it("returns the full comment when it fits", () => {
    const full = generatePullRequestComment(huge);

    expect(full.length).toBeLessThan(60_000);
    expect(full).not.toContain("Truncated");
    expect(generatePullRequestComment(huge, { maxLength: full.length })).toBe(full);
  });

  it("never exceeds the limit and always cuts between lines", () => {
    const full = generatePullRequestComment(huge);
    let sawClosedDetails = false;

    for (let maxLength = 60; maxLength < full.length; maxLength += 41) {
      const output = generatePullRequestComment(huge, { maxLength });
      expectWellFormed(output, maxLength);
      expect(output.startsWith(`${MARKER}\n`)).toBe(true);
      expect(output).toContain("**Truncated");
      sawClosedDetails ||= output.includes("</details>\n\n> **Truncated");
    }

    expect(sawClosedDetails).toBe(true);
  });

  it("keeps the integrity warnings ahead of the tables when truncating", () => {
    const output = generatePullRequestComment(huge, { maxLength: 1500 });

    expect(output).toContain("### Integrity / capture warnings");
    expect(output).toContain("Dropped watcher file events: 5");
    expect(output).toContain("Run `abb export` locally");
  });

  it("falls back to a cut-off marker when the limit is tiny", () => {
    expect(generatePullRequestComment(huge, { maxLength: 10 })).toBe("<!-- agen\n");
    expect(generatePullRequestComment(huge, { maxLength: 1 })).toBe("\n");
    expect(generatePullRequestComment(huge, { maxLength: 70 }).length).toBeLessThanOrEqual(70);
  });

  it("rejects an invalid limit", () => {
    expect(() => generatePullRequestComment(huge, { maxLength: 0 })).toThrow(RangeError);
    expect(() => generatePullRequestComment(huge, { maxLength: 1.5 })).toThrow(RangeError);
  });

  it("stays under GitHub's limit by default even with oversized fields", () => {
    const long = "x".repeat(5000);
    const comment = generatePullRequestComment(
      makeReport({
        risks: Array.from({ length: 50 }, (_, index) =>
          risk({ path: `${long}${index}`, reason: long, category: long })
        ),
        commands: Array.from({ length: 50 }, () => command({ command: long })),
      })
    );

    expect(comment.length).toBeLessThan(60_000);
    expect(comment).toContain("...");
  });
});
