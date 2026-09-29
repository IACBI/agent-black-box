import path from "node:path";
import { appendFile, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/config/defaults.js";
import { buildSessionReport } from "../src/reports/markdown.js";
import { writeReports } from "../src/reports/reportWriter.js";
import {
  buildSessionMetadata,
  listSessionCatalog,
  parseSessionReport,
  readCatalogSessionReport,
  resolveSessionEntry,
  SESSION_METADATA_FILE,
  verifyCatalogSessionReportFile,
} from "../src/session/sessionCatalog.js";
import { writeJsonFile } from "../src/utils/files.js";
import { INLINE_REPORT_BYTES, REPORT_REPLAY_FILE } from "../src/session/reportStorage.js";
import { createTempDir, removeTempDir } from "./testUtils.js";

describe("session catalog", () => {
  it("lists complete, legacy, incomplete, and corrupt sessions without trusting selector paths", async () => {
    const repo = await createTempDir("abb-catalog-");
    try {
      const sessionRoot = path.join(repo, DEFAULT_CONFIG.sessionDir);
      const olderId = "session-2026-01-01T00-00-00-000Z";
      const newerId = "session-2026-01-03T00-00-00-000Z";
      const incompleteId = "session-2026-01-04T00-00-00-000Z";
      const corruptId = "session-2026-01-02T00-00-00-000Z";

      const older = makeReport(repo, path.join(sessionRoot, olderId), olderId, "2026-01-01T00:00:00.000Z");
      const olderRaw = JSON.parse(JSON.stringify(older)) as Record<string, unknown>;
      delete olderRaw.commands;
      delete olderRaw.commandCapture;
      delete olderRaw.baseline;
      delete olderRaw.changeEvidence;
      delete olderRaw.riskSummary;
      delete olderRaw.integrity;
      await mkdir(older.sessionDir, { recursive: true });
      await writeJsonFile(path.join(older.sessionDir, "session.json"), olderRaw);

      const newer = makeReport(repo, path.join(sessionRoot, newerId), newerId, "2026-01-03T00:00:00.000Z");
      await mkdir(newer.sessionDir, { recursive: true });
      await writeJsonFile(path.join(newer.sessionDir, "session.json"), newer);
      await writeJsonFile(path.join(newer.sessionDir, SESSION_METADATA_FILE), buildSessionMetadata(newer));

      const incompleteDir = path.join(sessionRoot, incompleteId);
      await mkdir(incompleteDir, { recursive: true });
      await writeJsonFile(path.join(incompleteDir, "session-start.json"), {
        id: incompleteId,
        startedAt: "2026-01-04T00:00:00.000Z",
      });

      const corruptDir = path.join(sessionRoot, corruptId);
      await mkdir(corruptDir, { recursive: true });
      await writeJsonFile(path.join(corruptDir, "session.json"), { id: corruptId, invalid: true });

      const entries = await listSessionCatalog(repo, DEFAULT_CONFIG);

      expect(entries.map((entry) => [entry.id, entry.state])).toEqual([
        [incompleteId, "incomplete"],
        [newerId, "complete"],
        [olderId, "complete"],
        [corruptId, "corrupt"],
      ]);
      expect(resolveSessionEntry(entries, "latest").id).toBe(newerId);
      expect(resolveSessionEntry(entries, "session-2026-01-03").id).toBe(newerId);
      expect(() => resolveSessionEntry(entries, "session-2026")).toThrow("ambiguous");
      expect(() => resolveSessionEntry(entries, "../outside")).toThrow("Session selector must");
      expect(() => resolveSessionEntry(entries, incompleteId)).toThrow("incomplete");
      expect(() => resolveSessionEntry(entries, corruptId)).toThrow("corrupt");

      const normalizedLegacy = await readCatalogSessionReport(resolveSessionEntry(entries, olderId));
      expect(normalizedLegacy.commands).toEqual([]);
      expect(normalizedLegacy.baseline).toBeNull();
      expect(normalizedLegacy.changeEvidence.baselineAvailable).toBe(false);
      expect(normalizedLegacy.riskSummary.score).toBe(0);
    } finally {
      await removeTempDir(repo);
    }
  });

  it("falls back to session.json when compact metadata is corrupt", async () => {
    const repo = await createTempDir("abb-catalog-");
    try {
      const id = "session-2026-01-05T00-00-00-000Z";
      const sessionDir = path.join(repo, DEFAULT_CONFIG.sessionDir, id);
      const report = makeReport(repo, sessionDir, id, "2026-01-05T00:00:00.000Z");
      await mkdir(sessionDir, { recursive: true });
      await writeJsonFile(path.join(sessionDir, "session.json"), report);
      await writeJsonFile(path.join(sessionDir, SESSION_METADATA_FILE), { metadataVersion: 999 });

      const [entry] = await listSessionCatalog(repo, DEFAULT_CONFIG);

      expect(entry.state).toBe("complete");
      expect(entry.warning).toContain("derived from session.json");
    } finally {
      await removeTempDir(repo);
    }
  });

  it.each(["head", "indexFingerprint", "branch"])("rejects numeric Git %s in stored reports", async (field) => {
    const repo = await createTempDir("abb-catalog-");
    try {
      const id = "session-invalid-git";
      const report = makeReport(repo, path.join(repo, DEFAULT_CONFIG.sessionDir, id), id, "2026-01-05T00:00:00.000Z");
      await expectCorruptReport(repo, id, { ...report, git: { ...report.git, [field]: 42 } });
    } finally {
      await removeTempDir(repo);
    }
  });

  it.each([
    ["status", "modified"],
    ["kind", "text"],
    ["lineStatsSource", "git"],
  ])("rejects array-valued file %s in stored reports", async (field, value) => {
    const repo = await createTempDir("abb-catalog-");
    try {
      const id = "session-invalid-file";
      const report = makeReport(repo, path.join(repo, DEFAULT_CONFIG.sessionDir, id), id, "2026-01-05T00:00:00.000Z");
      await expectCorruptReport(repo, id, {
        ...report,
        git: { ...report.git, changedFiles: [{ path: "src/index.ts", status: "modified", [field]: [value] }] },
      });
    } finally {
      await removeTempDir(repo);
    }
  });

  it.each([
    {
      field: "risks",
      record: { path: "src/auth.ts", category: "auth", severity: ["high"], score: 90, reason: "Review." },
    },
    {
      field: "events",
      record: { timestamp: "2026-01-05T00:00:00.000Z", path: "src/index.ts", eventType: ["change"] },
    },
  ])("rejects array-valued enums in $field before rendering", async ({ field, record }) => {
    const repo = await createTempDir("abb-catalog-");
    try {
      const id = "session-invalid-enum";
      const report = makeReport(repo, path.join(repo, DEFAULT_CONFIG.sessionDir, id), id, "2026-01-05T00:00:00.000Z");
      await expectCorruptReport(repo, id, { ...report, [field]: [record] });
    } finally {
      await removeTempDir(repo);
    }
  });

  it.each(["head", "indexFingerprint", "branch"])(
    "normalizes invalid baseline Git %s to an unavailable baseline",
    (field) => {
      const report = makeReport(
        "/repo",
        "/repo/sessions/session-baseline",
        "session-baseline",
        "2026-01-05T00:00:00.000Z"
      );
      const parsed = parseSessionReport({
        ...report,
        baseline: { capturedAt: report.startedAt, git: { ...report.git, [field]: 42 } },
      });
      expect(parsed).not.toBeNull();
      expect(parsed?.baseline).toBeNull();
    }
  );

  it("derives invalid enum-valued metadata and risk summaries from the valid report", async () => {
    const repo = await createTempDir("abb-catalog-");
    try {
      const id = "session-invalid-summary";
      const sessionDir = path.join(repo, DEFAULT_CONFIG.sessionDir, id);
      const report = makeReport(repo, sessionDir, id, "2026-01-05T00:00:00.000Z");
      await mkdir(sessionDir, { recursive: true });
      await writeJsonFile(path.join(sessionDir, "session.json"), {
        ...report,
        riskSummary: { ...report.riskSummary, maxSeverity: ["high"] },
      });
      await writeJsonFile(path.join(sessionDir, SESSION_METADATA_FILE), {
        ...buildSessionMetadata(report),
        maxRiskSeverity: ["high"],
      });

      const [entry] = await listSessionCatalog(repo, DEFAULT_CONFIG);
      expect(entry.state).toBe("complete");
      expect(entry.warning).toContain("derived from session.json");
      expect(entry.maxRiskSeverity).toBe("none");
      expect((await readCatalogSessionReport(entry)).riskSummary.maxSeverity).toBe("none");
    } finally {
      await removeTempDir(repo);
    }
  });

  it("reopens a report larger than the inline read limit without changing session.json", async () => {
    const repo = await createTempDir("abb-large-catalog-");
    try {
      const id = "session-2026-01-06T00-00-00-000Z";
      const sessionDir = path.join(repo, DEFAULT_CONFIG.sessionDir, id);
      const report = makeReport(repo, sessionDir, id, "2026-01-06T00:00:00.000Z");
      const event = {
        timestamp: "2026-01-06T00:00:01.000Z",
        eventType: "change" as const,
        path: `src/${"x".repeat(30_000)}.ts`,
      };
      report.events = Array.from({ length: 1_200 }, () => event);
      report.integrity.discardedFileEventLines = 1;
      report.integrity.warnings.push("Discarded malformed file event on line 1.");
      await mkdir(sessionDir, { recursive: true });
      const eventPath = path.join(sessionDir, "events.ndjson");
      const invalidEvent = JSON.stringify({ ...event, timestamp: "invalid" });
      await writeFile(eventPath, `${invalidEvent}\n${report.events.map((item) => JSON.stringify(item)).join("\n")}\n`);
      await writeFile(path.join(sessionDir, "commands.ndjson"), "");

      await writeReports(report);
      expect((await stat(path.join(sessionDir, "session.json"))).size).toBeGreaterThan(INLINE_REPORT_BYTES);
      expect((await stat(path.join(sessionDir, REPORT_REPLAY_FILE))).size).toBeLessThan(INLINE_REPORT_BYTES);

      const [entry] = await listSessionCatalog(repo, DEFAULT_CONFIG);
      expect(entry.state).toBe("complete");
      const reopened = await readCatalogSessionReport(entry);
      expect(reopened.events).toHaveLength(1_200);
      expect(reopened.events[0]).toEqual(event);
      expect(reopened.integrity.discardedFileEventLines).toBe(1);
      await expect(verifyCatalogSessionReportFile(entry)).resolves.toBeUndefined();

      const replayPath = path.join(sessionDir, REPORT_REPLAY_FILE);
      const replayContents = await readFile(replayPath);
      await rm(replayPath);
      const [legacy] = await listSessionCatalog(repo, DEFAULT_CONFIG);
      expect(legacy.warning).toContain("requires more memory");
      expect((await readCatalogSessionReport(legacy)).events).toHaveLength(1_200);
      await writeFile(replayPath, replayContents);

      await writeJsonFile(path.join(sessionDir, SESSION_METADATA_FILE), { metadataVersion: 999 });
      const [fallback] = await listSessionCatalog(repo, DEFAULT_CONFIG);
      expect(fallback.state).toBe("complete");
      expect(fallback.warning).toContain("derived from session.json");

      await appendFile(eventPath, "\n");
      await expect(verifyCatalogSessionReportFile(fallback)).rejects.toThrow("event logs changed");
      await expect(readCatalogSessionReport(fallback)).rejects.toThrow("event logs changed");
    } finally {
      await removeTempDir(repo);
    }
  }, 120_000);
});

async function expectCorruptReport(repo: string, id: string, value: unknown): Promise<void> {
  const sessionDir = path.join(repo, DEFAULT_CONFIG.sessionDir, id);
  await mkdir(sessionDir, { recursive: true });
  await writeJsonFile(path.join(sessionDir, "session.json"), value);

  const [entry] = await listSessionCatalog(repo, DEFAULT_CONFIG);
  expect(entry.state).toBe("corrupt");
  await expect(readCatalogSessionReport({ id, sessionDir, state: "complete" })).rejects.toThrow("invalid session.json");
}

function makeReport(repoRoot: string, sessionDir: string, id: string, startedAt: string) {
  return buildSessionReport(
    { id, repoRoot, sessionDir, startedAt },
    new Date(Date.parse(startedAt) + 60_000).toISOString(),
    "test",
    [],
    [],
    {
      repoRoot,
      branch: "main",
      statusText: "Working tree clean for included paths.",
      diffSummaryText: "No tracked Git diff was detected.",
      changedFiles: [],
    },
    [],
    []
  );
}
