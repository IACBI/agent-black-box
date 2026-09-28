import { rm } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildSessionReport } from "../src/reports/markdown.js";
import { writeReports } from "../src/reports/reportWriter.js";
import { renderSessionCatalog, toPublicSessionCatalog } from "../src/reports/sessionCatalog.js";
import type { SessionCatalogEntry } from "../src/session/sessionCatalog.js";
import { filterSessionCatalog, SESSION_SEARCH_FILE } from "../src/session/sessionSearch.js";
import { createTempDir, removeTempDir } from "./testUtils.js";

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
