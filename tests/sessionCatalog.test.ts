import path from "node:path";
import { mkdir } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/config/defaults.js";
import { buildSessionReport } from "../src/reports/markdown.js";
import {
  buildSessionMetadata,
  listSessionCatalog,
  readCatalogSessionReport,
  resolveSessionEntry,
  SESSION_METADATA_FILE,
} from "../src/session/sessionCatalog.js";
import { writeJsonFile } from "../src/utils/files.js";
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
});

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
