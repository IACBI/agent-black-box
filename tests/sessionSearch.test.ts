import { appendFile, mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildSessionReport } from "../src/reports/markdown.js";
import { writeReports } from "../src/reports/reportWriter.js";
import { renderSessionCatalog, toPublicSessionCatalog } from "../src/reports/sessionCatalog.js";
import { listSessionCatalog, type SessionCatalogEntry } from "../src/session/sessionCatalog.js";
import {
  filterSessionCatalog,
  SESSION_SEARCH_FILE,
  validateSessionSearchFilters,
} from "../src/session/sessionSearch.js";
import { createTempDir, removeTempDir } from "./testUtils.js";
import { MaterializationBudgetError } from "../src/session/reportStorage.js";
import { DEFAULT_CONFIG } from "../src/config/defaults.js";
import { writeJsonFile } from "../src/utils/files.js";

describe("session history search", () => {
  it("filters by metadata and indexed file, command, and risk category", async () => {
    const repo = await createTempDir("abb-history-");
    try {
      const newest = makeReport(repo, "session-2026-01-03", "2026-01-03T00:00:00.000Z", "src/auth/login.ts");
      const older = makeReport(repo, "session-2026-01-01", "2026-01-01T00:00:00.000Z", "src/other.ts");
      await writeReports(newest);
      await writeReports(older);
      const entries: SessionCatalogEntry[] = [
        {
          id: newest.id,
          sessionDir: newest.sessionDir,
          state: "complete",
          startedAt: newest.startedAt,
          maxRiskSeverity: "high",
        },
        {
          id: older.id,
          sessionDir: older.sessionDir,
          state: "complete",
          startedAt: older.startedAt,
          maxRiskSeverity: "low",
        },
        {
          id: "session-2026-01-02",
          sessionDir: path.join(repo, "incomplete"),
          state: "incomplete",
          startedAt: "2026-01-02T00:00:00.000Z",
        },
      ];

      expect(
        (await filterSessionCatalog(entries, { file: "AUTH", command: "test", category: "security" })).map(
          (entry) => entry.id
        )
      ).toEqual([newest.id]);
      expect(
        (await filterSessionCatalog(entries, { since: "2026-01-02", minSeverity: "medium" })).map((entry) => entry.id)
      ).toEqual([newest.id]);
      expect((await filterSessionCatalog(entries, { state: "incomplete" })).map((entry) => entry.state)).toEqual([
        "incomplete",
      ]);
      expect((await filterSessionCatalog(entries, { limit: 1 })).map((entry) => entry.id)).toEqual([newest.id]);

      const filtered = await filterSessionCatalog(entries, { file: "other" });
      expect(toPublicSessionCatalog(filtered, newest.id)[0]?.latest).toBe(false);
      expect(renderSessionCatalog(filtered, newest.id)).not.toContain("latest");

      await rm(path.join(newest.sessionDir, SESSION_SEARCH_FILE));
      expect((await filterSessionCatalog(entries, { file: "auth" })).map((entry) => entry.id)).toEqual([newest.id]);
    } finally {
      await removeTempDir(repo);
    }
  });

  it("rejects invalid dates, limits, and empty search terms", async () => {
    await expect(filterSessionCatalog([], { since: "2026-02-30" })).rejects.toThrow("valid date");
    await expect(filterSessionCatalog([], { limit: 0 })).rejects.toThrow("positive integer");
    await expect(filterSessionCatalog([], { file: " " })).rejects.toThrow("History search terms");
    await expect(filterSessionCatalog([], {}, { maxMaterializedBytes: 0 })).rejects.toThrow("maxMaterializedBytes");
  });

  it("validates every filter synchronously so callers can reject before reading history", () => {
    expect(() => validateSessionSearchFilters({ since: "2026-02-30" })).toThrow("valid date");
    expect(() => validateSessionSearchFilters({ command: "a\nb" })).toThrow("History search terms");
    expect(validateSessionSearchFilters({ since: "2026-01-02" })).toBe(Date.parse("2026-01-02T00:00:00.000Z"));
    expect(validateSessionSearchFilters({ file: "src" })).toBeUndefined();
  });

  it("searches small indices within quota and enforces the same quota for report fallback", async () => {
    const repo = await createTempDir("abb-history-budget-");
    try {
      const report = makeReport(repo, "session-budget", "2026-01-03T00:00:00.000Z", "src/auth/login.ts");
      await writeReports(report);
      const entries: SessionCatalogEntry[] = [{ id: report.id, sessionDir: report.sessionDir, state: "complete" }];
      const indexPath = path.join(report.sessionDir, SESSION_SEARCH_FILE);
      const indexBytes = (await stat(indexPath)).size;
      const options = { maxMaterializedBytes: indexBytes };
      expect(await filterSessionCatalog(entries, { file: "auth" }, options)).toEqual(entries);
      await rm(indexPath);
      await expect(filterSessionCatalog(entries, { file: "auth" }, options)).rejects.toBeInstanceOf(
        MaterializationBudgetError
      );

      const reportBytes = (await stat(path.join(report.sessionDir, "session.json"))).size;
      const fallbackOptions = { maxMaterializedBytes: reportBytes };
      expect(await filterSessionCatalog(entries, { file: "auth" }, fallbackOptions)).toEqual(entries);
      // A valid but padded index may exceed the quota; a smaller valid report remains usable.
      await writeReports(report);
      await appendFile(indexPath, " ".repeat(reportBytes));
      expect(await filterSessionCatalog(entries, { file: "auth" }, fallbackOptions)).toEqual(entries);
    } finally {
      await removeTempDir(repo);
    }
  });

  it("refuses metadata-dependent filters without excluding sessions whose metadata exceeds the quota", async () => {
    const deferred: SessionCatalogEntry = {
      id: "session-deferred",
      sessionDir: "unused",
      state: "complete",
      metadataUnavailable: true,
      warning: "Report exceeds the working-data policy.",
    };
    const incomplete: SessionCatalogEntry = { id: "session-incomplete", sessionDir: "unused", state: "incomplete" };
    const entries = [deferred, incomplete];
    expect(await filterSessionCatalog(entries, {})).toEqual(entries);
    expect(await filterSessionCatalog(entries, { state: "incomplete", limit: 1 })).toEqual([incomplete]);
    await expect(filterSessionCatalog(entries, { since: "2026-01-01" })).rejects.toThrow("working-data policy");
    await expect(filterSessionCatalog(entries, { minSeverity: "high" })).rejects.toThrow("working-data policy");
    await expect(filterSessionCatalog(entries, { limit: 1 })).rejects.toThrow("working-data policy");
  });

  it("refuses date and limit filters for an incomplete session whose start record exceeds the quota", async () => {
    const repo = await createTempDir("abb-history-incomplete-budget-");
    try {
      const id = "session-incomplete-budget";
      const sessionDir = path.join(repo, DEFAULT_CONFIG.sessionDir, id);
      await mkdir(sessionDir, { recursive: true });
      await writeJsonFile(path.join(sessionDir, "session-start.json"), {
        id,
        startedAt: "2026-01-03T00:00:00.000Z",
        padding: "x".repeat(128),
      });
      const entries = await listSessionCatalog(repo, DEFAULT_CONFIG, { maxMaterializedBytes: 64 });
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({ id, state: "incomplete", metadataUnavailable: true });
      expect(await filterSessionCatalog(entries, { state: "incomplete" })).toEqual(entries);
      await expect(filterSessionCatalog(entries, { state: "incomplete", since: "2026-01-01" })).rejects.toThrow(
        "working-data policy"
      );
      await expect(filterSessionCatalog(entries, { state: "incomplete", limit: 1 })).rejects.toThrow(
        "working-data policy"
      );
      expect(await filterSessionCatalog(entries, { state: "incomplete", minSeverity: "high" })).toEqual([]);
    } finally {
      await removeTempDir(repo);
    }
  });
});

function makeReport(repoRoot: string, id: string, startedAt: string, filePath: string) {
  const sessionDir = path.join(repoRoot, ".agent-black-box", "sessions", id);
  return buildSessionReport(
    { id, repoRoot, sessionDir, startedAt },
    new Date(Date.parse(startedAt) + 60_000).toISOString(),
    "test",
    [],
    [
      {
        startedAt,
        endedAt: startedAt,
        command: "pnpm test",
        cwd: ".",
        exitCode: 0,
        durationMs: 0,
      },
    ],
    {
      repoRoot,
      branch: "main",
      statusText: "One changed file.",
      diffSummaryText: "One changed file.",
      changedFiles: [{ path: filePath, status: "modified" }],
    },
    [{ path: filePath, category: "Auth/security-related file", severity: "high", score: 90, reason: "Review." }],
    []
  );
}
