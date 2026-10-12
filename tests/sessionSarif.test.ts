import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { sarifArtifactUri, sarifLevel } from "../src/reports/sarif.js";
import { toSessionSarif } from "../src/reports/sessionSarif.js";
import type { RiskFinding, SecretFinding, SessionReport } from "../src/types.js";

const PLANTED_VALUE = "ghp_PLANTEDsecretVALUE0123456789abcdef";

function makeReport(overrides: Partial<SessionReport> = {}): SessionReport {
  const risks = overrides.risks ?? [];
  const possibleSecrets = overrides.possibleSecrets ?? [];
  return {
    id: "session-2026-01-01T00-00-00-000Z-1a2b3c4d-0000-4000-8000-000000000000",
    repoRoot: "/repo",
    sessionDir: "/repo/.agent-black-box/sessions/session-test",
    startedAt: "2026-01-01T00:00:00.000Z",
    endedAt: "2026-01-01T00:05:00.000Z",
    finalizedBy: "test",
    commandCapture: { implemented: true, mode: "wrapper-only", note: "note" },
    events: [],
    commands: [],
    baseline: null,
    changeEvidence: {
      baselineAvailable: false,
      headChanged: null,
      indexChanged: null,
      branchChanged: null,
      committedChanges: [],
      files: [],
    },
    git: { repoRoot: "/repo", statusText: "", diffSummaryText: "", changedFiles: [] },
    risks,
    riskSummary: {
      score: risks.length > 0 ? 90 : 0,
      maxSeverity: risks.length > 0 ? "high" : "none",
      possibleSecretCount: possibleSecrets.length,
      severityCounts: {
        high: risks.filter((risk) => risk.severity === "high").length,
        medium: risks.filter((risk) => risk.severity === "medium").length,
        low: risks.filter((risk) => risk.severity === "low").length,
      },
    },
    possibleSecrets,
    integrity: { warnings: [], discardedFileEventLines: 0, discardedCommandEventLines: 0 },
    ...overrides,
  };
}

const risks: RiskFinding[] = [
  { path: "src/low.ts", category: "Config file", severity: "low", score: 10, reason: "Low signal." },
  { path: "docs/spa ce/ünï.md", category: "Config file", severity: "medium", score: 50, reason: "Medium signal." },
  { path: ".env", category: "Environment file", severity: "high", score: 90, reason: "Environment file changed." },
  { path: "a#b/100%.txt", category: "Lockfile", severity: "high", score: 80, reason: "Lockfile changed." },
];

const secrets: SecretFinding[] = [
  { path: "config/app.ts", line: 12, reason: "Possible token detected.", redacted: PLANTED_VALUE },
  { path: "config/app.ts", line: 3, reason: "Possible token detected.", redacted: `${PLANTED_VALUE}-second` },
];

interface LoggedResult {
  ruleId: string;
  level: string;
  message: { text: string };
  locations: Array<{ physicalLocation: { artifactLocation: { uri: string }; region?: { startLine: number } } }>;
  partialFingerprints: Record<string, string>;
}

interface LoggedRun {
  tool: {
    driver: { name: string; informationUri: string; rules: Array<{ id: string; shortDescription: { text: string } }> };
  };
  invocations: Array<{ executionSuccessful: boolean; startTimeUtc: string; endTimeUtc: string }>;
  results: LoggedResult[];
  properties: Record<string, unknown>;
}

function firstRun(log: Record<string, unknown>): LoggedRun {
  return (log.runs as LoggedRun[])[0] as LoggedRun;
}

describe("sarif primitives", () => {
  it("maps severities to SARIF levels", () => {
    expect(sarifLevel("high")).toBe("error");
    expect(sarifLevel("medium")).toBe("warning");
    expect(sarifLevel("low")).toBe("note");
  });

  it("encodes each path segment but keeps separators", () => {
    expect(sarifArtifactUri("a b/c#d/e%f/ü.ts")).toBe("a%20b/c%23d/e%25f/%C3%BC.ts");
  });
});

describe("session SARIF", () => {
  it("emits the SARIF 2.1.0 required shape", () => {
    const log = toSessionSarif(makeReport({ risks, possibleSecrets: secrets }));

    expect(log.version).toBe("2.1.0");
    expect(log.$schema).toBe("https://json.schemastore.org/sarif-2.1.0.json");
    expect(log.runs).toHaveLength(1);

    const run = firstRun(log);
    expect(run.tool.driver.name).toBe("Agent Black Box");
    expect(run.tool.driver.informationUri).toBe("https://github.com/IACBI/agent-black-box");
    expect(run.results).toHaveLength(risks.length + secrets.length);

    const declaredRules = new Set(run.tool.driver.rules.map((rule) => rule.id));
    for (const rule of run.tool.driver.rules) {
      expect(rule.shortDescription.text.length).toBeGreaterThan(0);
    }
    for (const result of run.results) {
      expect(declaredRules.has(result.ruleId)).toBe(true);
      expect(["error", "warning", "note"]).toContain(result.level);
      expect(result.message.text.length).toBeGreaterThan(0);
      expect(result.locations).toHaveLength(1);
      expect(result.locations[0]?.physicalLocation.artifactLocation.uri).toMatch(/^[^\s]+$/);
    }
    expect(run.tool.driver.rules.map((rule) => rule.id)).toEqual([
      "possible-secret",
      "session-risk:Config file",
      "session-risk:Environment file",
      "session-risk:Lockfile",
    ]);
    expect(run.invocations).toEqual([
      { executionSuccessful: true, startTimeUtc: "2026-01-01T00:00:00.000Z", endTimeUtc: "2026-01-01T00:05:00.000Z" },
    ]);
  });

  it("orders results by severity, then path, then line", () => {
    const run = firstRun(toSessionSarif(makeReport({ risks, possibleSecrets: secrets })));
    const summary = run.results.map((result) => [
      result.ruleId,
      result.level,
      decodeURIComponent(result.locations[0]?.physicalLocation.artifactLocation.uri ?? ""),
      result.locations[0]?.physicalLocation.region?.startLine,
    ]);

    expect(summary).toEqual([
      ["session-risk:Environment file", "error", ".env", undefined],
      ["session-risk:Lockfile", "error", "a#b/100%.txt", undefined],
      ["possible-secret", "error", "config/app.ts", 3],
      ["possible-secret", "error", "config/app.ts", 12],
      ["session-risk:Config file", "warning", "docs/spa ce/ünï.md", undefined],
      ["session-risk:Config file", "note", "src/low.ts", undefined],
    ]);
  });

  it("produces the same log regardless of input order", () => {
    const forward = toSessionSarif(makeReport({ risks, possibleSecrets: secrets }));
    const backward = toSessionSarif(
      makeReport({ risks: [...risks].reverse(), possibleSecrets: [...secrets].reverse() })
    );

    expect(JSON.stringify(backward)).toBe(JSON.stringify(forward));
    expect(JSON.stringify(toSessionSarif(makeReport({ risks, possibleSecrets: secrets })))).toBe(
      JSON.stringify(forward)
    );
  });

  it("percent-encodes spaces, unicode, hashes and percent signs in artifact URIs", () => {
    const run = firstRun(toSessionSarif(makeReport({ risks })));
    const uris = run.results.map((result) => result.locations[0]?.physicalLocation.artifactLocation.uri);

    expect(uris).toContain("docs/spa%20ce/%C3%BCn%C3%AF.md");
    expect(uris).toContain("a%23b/100%25.txt");
    expect(uris).toContain(".env");
  });

  it("reports line regions for possible secrets only and never leaks matched text", () => {
    const serialized = JSON.stringify(toSessionSarif(makeReport({ risks, possibleSecrets: secrets })));

    expect(serialized).not.toContain(PLANTED_VALUE);
    expect(serialized).not.toContain("PLANTEDsecret");
    expect(serialized).not.toContain("redacted");

    const run = firstRun(JSON.parse(serialized) as Record<string, unknown>);
    for (const result of run.results) {
      const hasRegion = result.locations[0]?.physicalLocation.region !== undefined;
      expect(hasRegion).toBe(result.ruleId === "possible-secret");
    }
  });

  it("adds stable, distinct partial fingerprints", () => {
    const fingerprints = (report: SessionReport): string[] =>
      firstRun(toSessionSarif(report)).results.map((result) => Object.values(result.partialFingerprints)[0] ?? "");
    const first = fingerprints(makeReport({ risks, possibleSecrets: secrets }));
    const second = fingerprints(makeReport({ risks, possibleSecrets: secrets, endedAt: "2030-01-01T00:00:00.000Z" }));

    expect(second).toEqual(first);
    expect(new Set(first).size).toBe(first.length);
    for (const value of first) {
      expect(value).toMatch(/^[0-9a-f]{64}$/);
    }

    const envResult = firstRun(toSessionSarif(makeReport({ risks }))).results.find(
      (result) => result.locations[0]?.physicalLocation.artifactLocation.uri === ".env"
    );
    const expected = createHash("sha256").update("session-risk:Environment file|.env|").digest("hex");
    expect(Object.values(envResult?.partialFingerprints ?? {})).toEqual([expected]);
  });

  it("surfaces capture loss in run properties", () => {
    const run = firstRun(
      toSessionSarif(
        makeReport({
          risks,
          integrity: {
            warnings: ["Watcher queue overflowed."],
            discardedFileEventLines: 2,
            discardedCommandEventLines: 1,
            droppedFileEvents: 7,
            failedFileEventWrites: 3,
          },
        })
      )
    );

    expect(run.properties).toMatchObject({
      sessionId: "session-2026-01-01T00-00-00-000Z-1a2b3c4d-0000-4000-8000-000000000000",
      startedAt: "2026-01-01T00:00:00.000Z",
      endedAt: "2026-01-01T00:05:00.000Z",
      riskSummary: { maxSeverity: "high", severityCounts: { high: 2, medium: 1, low: 1 } },
      captureWarnings: {
        warnings: ["Watcher queue overflowed."],
        discardedFileEventLines: 2,
        discardedCommandEventLines: 1,
        droppedFileEvents: 7,
        failedFileEventWrites: 3,
      },
    });
  });

  it("omits optional capture counters that the report does not carry", () => {
    const run = firstRun(toSessionSarif(makeReport()));

    expect(run.properties.captureWarnings).toEqual({
      warnings: [],
      discardedFileEventLines: 0,
      discardedCommandEventLines: 0,
    });
  });

  it("yields a valid log with no results for an empty report", () => {
    const log = toSessionSarif(makeReport());
    const run = firstRun(log);

    expect(log.version).toBe("2.1.0");
    expect(run.results).toEqual([]);
    expect(run.tool.driver.rules).toEqual([]);
    expect(run.invocations[0]?.executionSuccessful).toBe(true);
    expect(JSON.parse(JSON.stringify(log))).toEqual(log);
  });
});
