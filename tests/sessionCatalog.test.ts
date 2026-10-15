import path from "node:path";
import { appendFile, mkdir, open, readFile, rm, stat, writeFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG } from "../src/config/defaults.js";
import { buildSessionReport, generateSummaryMarkdown } from "../src/reports/markdown.js";
import { writeReports } from "../src/reports/reportWriter.js";
import {
  buildSessionMetadata,
  listSessionCatalog,
  parseSessionReport,
  readCatalogSessionReport,
  readVerifiedCatalogSessionReportCore,
  resolveSessionEntry,
  SESSION_METADATA_FILE,
  verifyCatalogSessionReportFile,
} from "../src/session/sessionCatalog.js";
import { writeJsonFile } from "../src/utils/files.js";
import * as files from "../src/utils/files.js";
import { digestRecords, INLINE_REPORT_BYTES, REPORT_REPLAY_FILE } from "../src/session/reportStorage.js";
import { createTempDir, removeTempDir } from "./testUtils.js";

describe("session catalog", () => {
  it.each([0, -1, 1.5, 4294967297, NaN, Infinity])(
    "rejects invalid materialization limits %s before filesystem reads",
    async (maxMaterializedBytes) => {
      await expect(listSessionCatalog("unopened-repository", DEFAULT_CONFIG, { maxMaterializedBytes })).rejects.toThrow(
        "maxMaterializedBytes"
      );
      await expect(
        verifyCatalogSessionReportFile(
          { id: "session-test", sessionDir: "unopened-session", state: "complete" },
          { maxMaterializedBytes }
        )
      ).rejects.toThrow("maxMaterializedBytes");
    }
  );

  it("distinguishes metadata and start-record policy refusals from corrupted data", async () => {
    const repo = await createTempDir("abb-catalog-policy-");
    try {
      const id = "session-policy-metadata";
      const sessionDir = path.join(repo, DEFAULT_CONFIG.sessionDir, id);
      const report = makeReport(repo, sessionDir, id, "2026-01-05T00:00:00.000Z");
      await mkdir(sessionDir, { recursive: true });
      await writeJsonFile(path.join(sessionDir, "session.json"), report);
      await writeJsonFile(path.join(sessionDir, SESSION_METADATA_FILE), {
        ...buildSessionMetadata(report),
        padding: "x".repeat(8192),
      });
      const [entry] = await listSessionCatalog(repo, DEFAULT_CONFIG, { maxMaterializedBytes: 4096 });
      expect(entry).toMatchObject({
        id,
        state: "complete",
        startedAt: report.startedAt,
        warning: expect.stringContaining("working-data policy"),
      });
      expect(entry.warning).not.toContain("Invalid metadata");
      expect(entry.metadataUnavailable).toBeUndefined();
      await rm(sessionDir, { recursive: true });
      const incompleteId = "session-policy-start";
      const incompleteDir = path.join(repo, DEFAULT_CONFIG.sessionDir, incompleteId);
      await mkdir(incompleteDir);
      await writeJsonFile(path.join(incompleteDir, "session-start.json"), {
        id: incompleteId,
        startedAt: report.startedAt,
      });
      const [incomplete] = await listSessionCatalog(repo, DEFAULT_CONFIG, { maxMaterializedBytes: 64 });
      expect(incomplete).toMatchObject({
        id: incompleteId,
        state: "incomplete",
        metadataUnavailable: true,
        warning: expect.stringContaining("working-data policy"),
      });
    } finally {
      await removeTempDir(repo);
    }
  });

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
      expect(() => resolveSessionEntry(entries, "")).toThrow("Session selector must not be empty.");
      expect(() => resolveSessionEntry(entries, "   ")).toThrow("Session selector must not be empty.");
      expect(resolveSessionEntry(entries, undefined).id).toBe(newerId);
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

  it.each([undefined, 1024 * 1024])(
    "bounds fallback and metadata reads with input quota %s",
    async (maxMaterializedBytes) => {
      const repo = await createTempDir("abb-catalog-concurrency-");
      const readFileLimited = files.readFileLimited;
      let activeReportReads = 0;
      let maximumReportReads = 0;
      let metadataReads = 0;
      let activeMetadataReads = 0;
      let maximumMetadataReads = 0;
      let restoreReader: (() => void) | undefined;
      try {
        for (let index = 0; index < 8; index += 1) {
          const id = `session-concurrency-${index}`;
          const sessionDir = path.join(repo, DEFAULT_CONFIG.sessionDir, id);
          const report = makeReport(repo, sessionDir, id, "2026-01-05T00:00:00.000Z");
          await mkdir(sessionDir, { recursive: true });
          await writeJsonFile(path.join(sessionDir, "session.json"), report);
          if (index % 2 === 0) {
            await writeJsonFile(path.join(sessionDir, SESSION_METADATA_FILE), buildSessionMetadata(report));
          }
        }
        const reader = vi.spyOn(files, "readFileLimited").mockImplementation(async (filePath, maxBytes) => {
          if (path.basename(filePath) !== "session.json") {
            metadataReads += 1;
            activeMetadataReads += 1;
            maximumMetadataReads = Math.max(maximumMetadataReads, activeMetadataReads);
            try {
              await new Promise((resolve) => setTimeout(resolve, 10));
              return await readFileLimited(filePath, maxBytes);
            } finally {
              activeMetadataReads -= 1;
            }
          }
          activeReportReads += 1;
          maximumReportReads = Math.max(maximumReportReads, activeReportReads);
          try {
            expect(metadataReads).toBe(4);
            await new Promise((resolve) => setTimeout(resolve, 10));
            return await readFileLimited(filePath, maxBytes);
          } finally {
            activeReportReads -= 1;
          }
        });
        restoreReader = () => reader.mockRestore();

        const entries = await listSessionCatalog(repo, DEFAULT_CONFIG, { maxMaterializedBytes });
        expect(entries).toHaveLength(8);
        expect(entries.every((entry) => entry.state === "complete")).toBe(true);
        expect(maximumReportReads).toBe(1);
        expect(maximumMetadataReads).toBe(maxMaterializedBytes === undefined ? 4 : 1);
      } finally {
        restoreReader?.();
        await removeTempDir(repo);
      }
    }
  );

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

  it.each([
    null,
    {},
    [{ path: "config/.env", line: 1, reason: "Possible secret", redacted: 42 }],
    [{ path: "config/.env", line: 0, reason: "Possible secret", redacted: "<redacted>" }],
    [{ path: "config/.env", line: -1, reason: "Possible secret", redacted: "<redacted>" }],
    [{ path: "config/.env", line: Number.MAX_SAFE_INTEGER + 1, reason: "Possible secret", redacted: "<redacted>" }],
  ])("refuses malformed stored secret findings %j without removing evidence", async (possibleSecrets) => {
    const repo = await createTempDir("abb-catalog-secrets-");
    try {
      const id = "session-invalid-secrets";
      const sessionDir = path.join(repo, DEFAULT_CONFIG.sessionDir, id);
      const report = makeReport(repo, sessionDir, id, "2026-01-05T00:00:00.000Z");
      const stored = { ...report, possibleSecrets };
      await expectCorruptReport(repo, id, stored);
      await expect(verifyCatalogSessionReportFile({ id, sessionDir, state: "complete" })).rejects.toThrow(
        "invalid session.json"
      );
      expect(JSON.parse(await readFile(path.join(sessionDir, "session.json"), "utf8"))).toEqual(stored);
    } finally {
      await removeTempDir(repo);
    }
  });

  it("preserves valid secret locations and supports legacy reports without a secret field", async () => {
    const repo = await createTempDir("abb-catalog-legacy-secrets-");
    try {
      const id = "session-legacy-secrets";
      const sessionDir = path.join(repo, DEFAULT_CONFIG.sessionDir, id);
      const report = makeReport(repo, sessionDir, id, "2026-01-05T00:00:00.000Z");
      report.possibleSecrets = [{ path: "config/.env", line: 1, reason: "Possible secret", redacted: "<redacted>" }];
      await mkdir(sessionDir, { recursive: true });
      const reportPath = path.join(sessionDir, "session.json");
      await writeJsonFile(reportPath, report);
      const entry = { id, sessionDir, state: "complete" as const };
      expect((await readCatalogSessionReport(entry)).possibleSecrets).toEqual(report.possibleSecrets);
      await expect(verifyCatalogSessionReportFile(entry)).resolves.toBeUndefined();

      const legacy = JSON.parse(JSON.stringify(report)) as Record<string, unknown>;
      delete legacy.possibleSecrets;
      await writeJsonFile(reportPath, legacy);
      expect((await readCatalogSessionReport(entry)).possibleSecrets).toEqual([]);
      await expect(verifyCatalogSessionReportFile(entry)).resolves.toBeUndefined();
    } finally {
      await removeTempDir(repo);
    }
  });

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

  it.each([42, {}, "invalid"])("normalizes invalid baseline capture time %j before rendering", (capturedAt) => {
    const report = makeReport(
      "/repo",
      "/repo/sessions/session-evidence",
      "session-evidence",
      "2026-01-05T00:00:00.000Z"
    );
    const parsed = parseSessionReport({
      ...report,
      baseline: { capturedAt: report.startedAt, git: report.git },
      changeEvidence: {
        ...report.changeEvidence,
        baselineAvailable: true,
        baselineCapturedAt: capturedAt,
      },
    });

    expect(parsed).not.toBeNull();
    expect(parsed?.changeEvidence.baselineAvailable).toBe(false);
    expect(parsed?.changeEvidence.baselineCapturedAt).toBeUndefined();
    expect(() => generateSummaryMarkdown(parsed!)).not.toThrow();
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
      report.git.statusText += " \uFFFD";
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
      const reportPath = path.join(sessionDir, "session.json");
      const materializedBytes =
        (await stat(reportPath)).size + (await stat(path.join(sessionDir, REPORT_REPLAY_FILE))).size;
      await expect(readCatalogSessionReport(entry, { maxMaterializedBytes: INLINE_REPORT_BYTES })).rejects.toThrow(
        "working-data policy"
      );
      const budgeted = await readCatalogSessionReport(entry, { maxMaterializedBytes: materializedBytes });
      expect(budgeted).toEqual(reopened);
      const verifiedCore = await readVerifiedCatalogSessionReportCore(entry, { maxMaterializedBytes: 1024 * 1024 });
      expect(verifiedCore).toEqual({
        report: { ...reopened, events: [], commands: [] },
        eventCount: 1_200,
        commandCount: 0,
        commandDigest: digestRecords([]),
      });
      const replayBytes = (await stat(path.join(sessionDir, REPORT_REPLAY_FILE))).size;
      await expect(verifyCatalogSessionReportFile(entry, { maxMaterializedBytes: replayBytes })).rejects.toThrow(
        "working-data policy"
      );
      const coreBytes = Buffer.byteLength(`${JSON.stringify({ ...report, events: [], commands: [] }, null, 2)}\n`);
      await expect(
        verifyCatalogSessionReportFile(entry, { maxMaterializedBytes: replayBytes + coreBytes + 64 * 1024 })
      ).resolves.toBeUndefined();
      await expect(
        verifyCatalogSessionReportFile(entry, { maxMaterializedBytes: replayBytes + coreBytes - 1 })
      ).rejects.toThrow("working-data policy");

      const handle = await open(eventPath, "r+");
      const eventOffset = Buffer.byteLength(invalidEvent) + 1 + JSON.stringify(event).indexOf("src/") + 4;
      try {
        await handle.write(Buffer.from("y"), 0, 1, eventOffset);
        await expect(readCatalogSessionReport(entry, { maxMaterializedBytes: materializedBytes })).rejects.toThrow(
          "event logs no longer match"
        );
        const replayPath = path.join(sessionDir, REPORT_REPLAY_FILE);
        const originalReplay = await readFile(replayPath, "utf8");
        const pairedTamper = JSON.parse(originalReplay) as { eventsDigest: string };
        pairedTamper.eventsDigest = digestRecords([
          { ...event, path: `src/y${event.path.slice(5)}` },
          ...report.events.slice(1),
        ]);
        await writeJsonFile(replayPath, pairedTamper);
        try {
          await expect(readCatalogSessionReport(entry)).rejects.toThrow("records no longer match replay metadata");
          await expect(verifyCatalogSessionReportFile(entry, { verifyEventLogs: true })).rejects.toThrow(
            "records no longer match replay metadata"
          );
          await expect(readVerifiedCatalogSessionReportCore(entry)).rejects.toThrow(
            "records no longer match replay metadata"
          );
          await expect(readCatalogSessionReport(entry, { maxMaterializedBytes: materializedBytes })).rejects.toThrow(
            "records no longer match replay metadata"
          );
        } finally {
          await writeFile(replayPath, originalReplay);
        }
      } finally {
        await handle.write(Buffer.from("x"), 0, 1, eventOffset);
        await handle.close();
      }

      const initialReplay = await readFile(path.join(sessionDir, REPORT_REPLAY_FILE), "utf8");
      const alteredReplay = JSON.parse(initialReplay) as { report: { finalizedBy: string } };
      alteredReplay.report.finalizedBy = "altered";
      await writeJsonFile(path.join(sessionDir, REPORT_REPLAY_FILE), alteredReplay);
      try {
        await expect(readCatalogSessionReport(entry)).rejects.toThrow("records no longer match replay metadata");
        await expect(verifyCatalogSessionReportFile(entry)).rejects.toThrow("records no longer match replay metadata");
        await expect(readVerifiedCatalogSessionReportCore(entry)).rejects.toThrow(
          "records no longer match replay metadata"
        );
        const metadataPath = path.join(sessionDir, SESSION_METADATA_FILE);
        const metadataContents = await readFile(metadataPath);
        await rm(metadataPath);
        try {
          expect((await listSessionCatalog(repo, DEFAULT_CONFIG))[0]).toMatchObject({
            state: "corrupt",
            warning: expect.stringContaining("records no longer match replay metadata"),
          });
        } finally {
          await writeFile(metadataPath, metadataContents);
        }
        await expect(
          readCatalogSessionReport(entry, { maxMaterializedBytes: materializedBytes + 1024 })
        ).rejects.toThrow("records no longer match replay metadata");
      } finally {
        await writeFile(path.join(sessionDir, REPORT_REPLAY_FILE), initialReplay);
      }

      const reorderedReplay = JSON.parse(initialReplay) as { report: Record<string, unknown> };
      reorderedReplay.report = Object.fromEntries(Object.entries(reorderedReplay.report).reverse());
      await writeJsonFile(path.join(sessionDir, REPORT_REPLAY_FILE), reorderedReplay);
      try {
        await expect(verifyCatalogSessionReportFile(entry)).resolves.toBeUndefined();
      } finally {
        await writeFile(path.join(sessionDir, REPORT_REPLAY_FILE), initialReplay);
      }

      const unknownFieldReplay = JSON.parse(initialReplay) as { report: Record<string, unknown> };
      unknownFieldReplay.report.extra = { retained: true };
      await writeJsonFile(path.join(sessionDir, REPORT_REPLAY_FILE), unknownFieldReplay);
      try {
        await expect(verifyCatalogSessionReportFile(entry)).rejects.toThrow("records no longer match replay metadata");
      } finally {
        await writeFile(path.join(sessionDir, REPORT_REPLAY_FILE), initialReplay);
      }

      // Mutate the file after replay verification but before the full bounded read, without changing its size.
      const originalReport = await readFile(reportPath, "utf8");
      const readFileLimited = files.readFileLimited;
      const reader = vi.spyOn(files, "readFileLimited").mockImplementation(async (filePath, maxBytes) => {
        if (filePath === reportPath) {
          await writeFile(reportPath, originalReport.replace("Working tree clean", "Working tree dirty"));
        }
        return readFileLimited(filePath, maxBytes);
      });
      try {
        await expect(readCatalogSessionReport(entry, { maxMaterializedBytes: materializedBytes })).rejects.toThrow(
          "changed after finalization"
        );
      } finally {
        reader.mockRestore();
        await writeFile(reportPath, originalReport);
      }

      // These three invalid UTF-8 bytes decode to the same replacement character as the original bytes.
      const replacementOffset = Buffer.from(originalReport).indexOf(Buffer.from("\uFFFD"));
      expect(replacementOffset).toBeGreaterThanOrEqual(0);
      const malformedBytes = Buffer.from([0xf0, 0x9f, 0x80]);
      expect(malformedBytes.toString("utf8")).toBe("\uFFFD");
      const rawReader = vi.spyOn(files, "readFileLimited").mockImplementation(async (filePath, maxBytes) => {
        if (filePath === reportPath) {
          const reportHandle = await open(reportPath, "r+");
          try {
            await reportHandle.write(malformedBytes, 0, malformedBytes.length, replacementOffset);
          } finally {
            await reportHandle.close();
          }
        }
        return readFileLimited(filePath, maxBytes);
      });
      try {
        await expect(readCatalogSessionReport(entry, { maxMaterializedBytes: materializedBytes })).rejects.toThrow(
          "changed after finalization"
        );
      } finally {
        rawReader.mockRestore();
        await writeFile(reportPath, originalReport);
      }
      await expect(verifyCatalogSessionReportFile(entry)).resolves.toBeUndefined();
      await expect(verifyCatalogSessionReportFile(entry, { verifyEventLogs: true })).resolves.toBeUndefined();

      const replayPath = path.join(sessionDir, REPORT_REPLAY_FILE);
      const replayContents = await readFile(replayPath);
      await rm(replayPath);
      const [legacy] = await listSessionCatalog(repo, DEFAULT_CONFIG);
      expect(legacy.warning).toContain("requires more memory");
      expect((await readCatalogSessionReport(legacy)).events).toHaveLength(1_200);
      await expect(verifyCatalogSessionReportFile(legacy, { maxMaterializedBytes: 1024 * 1024 })).rejects.toThrow(
        "session.json requires"
      );
      const metadataPath = path.join(sessionDir, SESSION_METADATA_FILE);
      const metadataContents = await readFile(metadataPath);
      await rm(metadataPath);
      const [deferred] = await listSessionCatalog(repo, DEFAULT_CONFIG, { maxMaterializedBytes: 1024 * 1024 });
      expect(deferred).toMatchObject({
        id,
        state: "complete",
        metadataUnavailable: true,
        warning: expect.stringContaining("working-data policy"),
      });
      expect(() => resolveSessionEntry([deferred], "latest")).toThrow("Latest session cannot be determined");
      expect(resolveSessionEntry([deferred], id).id).toBe(id);
      await writeFile(metadataPath, metadataContents);
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
