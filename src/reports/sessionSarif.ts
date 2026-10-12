import { createHash } from "node:crypto";
import type { RiskSeverity, SessionReport } from "../types.js";
import {
  SARIF_SCHEMA_URL,
  SARIF_VERSION,
  TOOL_INFORMATION_URI,
  sarifArtifactUri,
  sarifLevel,
  type SarifLevel,
} from "./sarif.js";

const POSSIBLE_SECRET_RULE_ID = "possible-secret";
const FINGERPRINT_KEY = "agentBlackBoxFinding/v1";

interface SessionSarifResult {
  ruleId: string;
  level: SarifLevel;
  message: { text: string };
  locations: Array<{
    physicalLocation: {
      artifactLocation: { uri: string };
      region?: { startLine: number };
    };
  }>;
  partialFingerprints: Record<string, string>;
  /** Not emitted; only used to order results deterministically. */
  sortKey: { rank: number; path: string; line: number };
}

const SEVERITY_RANK: Record<RiskSeverity, number> = { high: 3, medium: 2, low: 1 };

/**
 * Converts a recorded session into a SARIF 2.1.0 log.
 *
 * Risk findings become results without a line region. Possible secrets become `error` results at their line;
 * the matched value is never emitted, only the fixed detector reason. The output depends only on `report`.
 */
export function toSessionSarif(report: SessionReport): Record<string, unknown> {
  const pending: SessionSarifResult[] = [
    ...report.risks.map((risk) =>
      buildResult({
        ruleId: `session-risk:${risk.category}`,
        level: sarifLevel(risk.severity),
        rank: SEVERITY_RANK[risk.severity],
        path: risk.path,
        message: risk.reason,
      })
    ),
    ...report.possibleSecrets.map((secret) =>
      buildResult({
        ruleId: POSSIBLE_SECRET_RULE_ID,
        level: "error",
        rank: SEVERITY_RANK.high,
        path: secret.path,
        line: secret.line,
        message: secret.reason,
      })
    ),
  ];

  pending.sort(
    (a, b) =>
      b.sortKey.rank - a.sortKey.rank ||
      compareText(a.sortKey.path, b.sortKey.path) ||
      a.sortKey.line - b.sortKey.line ||
      compareText(a.ruleId, b.ruleId) ||
      compareText(a.message.text, b.message.text)
  );

  const results = pending.map(({ sortKey: _sortKey, ...result }) => result);
  const ruleIds = [...new Set(results.map((result) => result.ruleId))].sort(compareText);

  return {
    version: SARIF_VERSION,
    $schema: SARIF_SCHEMA_URL,
    runs: [
      {
        tool: {
          driver: {
            name: "Agent Black Box",
            informationUri: TOOL_INFORMATION_URI,
            rules: ruleIds.map((id) => ({ id, shortDescription: { text: describeRule(id) } })),
          },
        },
        invocations: [
          {
            executionSuccessful: true,
            startTimeUtc: report.startedAt,
            endTimeUtc: report.endedAt,
          },
        ],
        results,
        properties: {
          sessionId: report.id,
          startedAt: report.startedAt,
          endedAt: report.endedAt,
          riskSummary: report.riskSummary,
          captureWarnings: buildCaptureWarnings(report.integrity),
        },
      },
    ],
  };
}

function buildResult(input: {
  ruleId: string;
  level: SarifLevel;
  rank: number;
  path: string;
  line?: number;
  message: string;
}): SessionSarifResult {
  return {
    ruleId: input.ruleId,
    level: input.level,
    message: { text: input.message },
    locations: [
      {
        physicalLocation: {
          artifactLocation: { uri: sarifArtifactUri(input.path) },
          ...(input.line === undefined ? {} : { region: { startLine: input.line } }),
        },
      },
    ],
    partialFingerprints: { [FINGERPRINT_KEY]: fingerprint(input.ruleId, input.path, input.line) },
    sortKey: { rank: input.rank, path: input.path, line: input.line ?? 0 },
  };
}

function fingerprint(ruleId: string, path: string, line: number | undefined): string {
  return createHash("sha256")
    .update(`${ruleId}|${path}|${line ?? ""}`)
    .digest("hex");
}

function describeRule(ruleId: string): string {
  if (ruleId === POSSIBLE_SECRET_RULE_ID) {
    return "Possible secret-like value in a file changed during the session.";
  }

  return `Risky change during the session: ${ruleId.slice("session-risk:".length)}.`;
}

function buildCaptureWarnings(integrity: SessionReport["integrity"]): Record<string, unknown> {
  return {
    warnings: integrity.warnings,
    discardedFileEventLines: integrity.discardedFileEventLines,
    discardedCommandEventLines: integrity.discardedCommandEventLines,
    ...(integrity.droppedFileEvents === undefined ? {} : { droppedFileEvents: integrity.droppedFileEvents }),
    ...(integrity.failedFileEventWrites === undefined
      ? {}
      : { failedFileEventWrites: integrity.failedFileEventWrites }),
  };
}

// Code-unit comparison keeps the order independent of the host locale.
function compareText(a: string, b: string): number {
  if (a === b) {
    return 0;
  }

  return a < b ? -1 : 1;
}
