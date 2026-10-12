import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/config/defaults.js";
import { buildSessionReport } from "../src/reports/markdown.js";
import { writeReports } from "../src/reports/reportWriter.js";
import { buildSessionMetadata, listSessionCatalog, SESSION_METADATA_FILE } from "../src/session/sessionCatalog.js";
import { inspectSessionIndexes } from "../src/session/sessionIndex.js";
import { buildSessionSearchIndex, SESSION_SEARCH_FILE } from "../src/session/sessionSearch.js";
import { verifySessions } from "../src/session/sessionVerification.js";
import { getSessionVerificationLimits } from "../src/session/sessionVerification.js";
import { INLINE_REPORT_BYTES } from "../src/session/reportStorage.js";
import { writeJsonFile } from "../src/utils/files.js";
import { createTempDir, removeTempDir } from "./testUtils.js";

describe("derived session indexes", () => {
  it("regenerates a large session's command index and exact count using bounded canonical replay", async () => {
    const repo = await createTempDir("abb-index-replay-");
    try {
      const report = makeReport(repo);
      const command = { ...report.commands[0], command: `tool ${"x".repeat(3000)}` };
      report.commands = Array.from({ length: 12_000 }, () => command);
      await mkdir(report.sessionDir, { recursive: true });
      await writeFile(path.join(report.sessionDir, "events.ndjson"), "");
      await writeFile(
        path.join(report.sessionDir, "commands.ndjson"),
        `${report.commands.map((value) => JSON.stringify(value)).join("\n")}\n`
      );
      await writeReports(report);
      expect((await readFile(path.join(report.sessionDir, "session.json"))).length).toBeGreaterThan(
        INLINE_REPORT_BYTES
      );
      const [entry] = await listSessionCatalog(repo, DEFAULT_CONFIG);
      await rm(path.join(report.sessionDir, SESSION_SEARCH_FILE));
      await writeJsonFile(path.join(report.sessionDir, SESSION_METADATA_FILE), {
        ...buildSessionMetadata(report),
        commandCount: 1,
      });
      const summary = await verifySessions([entry], { memoryBudgetMb: 8, repairIndexes: true });
      expect(summary.sessions[0]).toMatchObject({
        status: "verified",
        repairedIndexes: [SESSION_SEARCH_FILE, SESSION_METADATA_FILE],
      });
      expect(summary.sessions[0].indexError).toBeUndefined();
      expect(JSON.parse(await readFile(path.join(report.sessionDir, SESSION_SEARCH_FILE), "utf8")).commands).toEqual([
        command.command,
      ]);
      expect((await listSessionCatalog(repo, DEFAULT_CONFIG))[0].commandCount).toBe(12_000);
      expect(
        (await verifySessions([entry], { memoryBudgetMb: 8, checkIndexes: true })).sessions[0].indexIssues
      ).toBeUndefined();
    } finally {
      await removeTempDir(repo);
    }
  }, 120_000);

  it("recognizes an oversized search index omitted by the report writer while checking metadata", async () => {
    const repo = await createTempDir("abb-index-oversized-");
    try {
      const report = makeReport(repo);
      report.commands = Array.from({ length: 1400 }, (_, index) => ({
        ...report.commands[0],
        command: `tool ${index} ${"x".repeat(3000)}`,
      }));
      await writeReports(report);
      const [entry] = await listSessionCatalog(repo, DEFAULT_CONFIG);
      expect(await inspectSessionIndexes(entry, { repair: true })).toEqual({
        issues: [],
        repaired: [],
        skipped: [SESSION_SEARCH_FILE],
      });
      await expect(readFile(path.join(report.sessionDir, SESSION_SEARCH_FILE))).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await removeTempDir(repo);
    }
  });

  it("refuses index reads exceeding the explicit working-data quota without overwriting them", async () => {
    const repo = await createTempDir("abb-index-budget-");
    try {
      const report = makeReport(repo);
      await writeReports(report);
      const [entry] = await listSessionCatalog(repo, DEFAULT_CONFIG);
      const limit = getSessionVerificationLimits({ memoryBudgetMb: 8 }).maxMaterializedBytes!;
      const target = path.join(report.sessionDir, SESSION_SEARCH_FILE);
      const evidence = `${JSON.stringify(buildSessionSearchIndex(report))}${" ".repeat(limit)}`;
      await writeFile(target, evidence);
      await expect(inspectSessionIndexes(entry, { repair: true, maxMaterializedBytes: limit })).rejects.toThrow(
        "working-data policy"
      );
      expect(await readFile(target, "utf8")).toBe(evidence);
    } finally {
      await removeTempDir(repo);
    }
  });

  it("detects valid-but-stale indices read-only and regenerates them without changing canonical evidence", async () => {
    const repo = await createTempDir("abb-index-");
    try {
      const report = makeReport(repo);
      await writeReports(report);
      const canonicalPath = path.join(report.sessionDir, "session.json");
      const canonicalBefore = await readFile(canonicalPath);
      await writeJsonFile(path.join(report.sessionDir, SESSION_METADATA_FILE), {
        ...buildSessionMetadata(report),
        commandCount: 17,
      });
      await writeJsonFile(path.join(report.sessionDir, SESSION_SEARCH_FILE), {
        ...buildSessionSearchIndex(report),
        paths: ["wrong.ts"],
      });
      const [entry] = await listSessionCatalog(repo, DEFAULT_CONFIG);
      expect(entry.commandCount).toBe(17);
      const before = await readFile(path.join(report.sessionDir, SESSION_SEARCH_FILE));
      const checked = await verifySessions([entry], { checkIndexes: true });
      expect(checked.sessions[0]).toMatchObject({
        status: "verified",
        indexIssues: [SESSION_SEARCH_FILE, SESSION_METADATA_FILE],
      });
      expect(checked.sessions[0].repairedIndexes).toBeUndefined();
      expect(await readFile(path.join(report.sessionDir, SESSION_SEARCH_FILE))).toEqual(before);
      const repaired = await verifySessions([entry], { repairIndexes: true });
      expect(repaired.sessions[0]).toMatchObject({
        status: "verified",
        repairedIndexes: [SESSION_SEARCH_FILE, SESSION_METADATA_FILE],
      });
      expect(await inspectSessionIndexes(entry)).toEqual({ issues: [], repaired: [], skipped: [] });
      expect(await readFile(canonicalPath)).toEqual(canonicalBefore);
      expect((await listSessionCatalog(repo, DEFAULT_CONFIG))[0].commandCount).toBe(1);
    } finally {
      await removeTempDir(repo);
    }
  });

  it.each(["missing", "invalid JSON"])("repairs %s derived files from verified canonical evidence", async (kind) => {
    const repo = await createTempDir("abb-index-");
    try {
      const report = makeReport(repo);
      await writeReports(report);
      const [entry] = await listSessionCatalog(repo, DEFAULT_CONFIG);
      for (const name of [SESSION_SEARCH_FILE, SESSION_METADATA_FILE]) {
        if (kind === "missing") {
          await rm(path.join(report.sessionDir, name));
        } else {
          await writeFile(path.join(report.sessionDir, name), "not JSON");
        }
      }
      expect((await inspectSessionIndexes(entry, { repair: true })).repaired).toEqual([
        SESSION_SEARCH_FILE,
        SESSION_METADATA_FILE,
      ]);
      expect(await inspectSessionIndexes(entry)).toEqual({ issues: [], repaired: [], skipped: [] });
    } finally {
      await removeTempDir(repo);
    }
  });

  it("refuses repair while session ownership needs recovery", async () => {
    const repo = await createTempDir("abb-index-");
    try {
      const report = makeReport(repo);
      await writeReports(report);
      const [entry] = await listSessionCatalog(repo, DEFAULT_CONFIG);
      await rm(path.join(report.sessionDir, SESSION_SEARCH_FILE));
      const lockPath = path.join(path.dirname(path.dirname(report.sessionDir)), "session.lock");
      await writeFile(lockPath, "{}");
      await expect(inspectSessionIndexes(entry, { repair: true })).rejects.toThrow("active");
      expect(await inspectSessionIndexes(entry)).toMatchObject({ issues: [SESSION_SEARCH_FILE], repaired: [] });
    } finally {
      await removeTempDir(repo);
    }
  });

  it("never replaces a linked derived target or changes its external data", async () => {
    const repo = await createTempDir("abb-index-");
    try {
      const report = makeReport(repo);
      await writeReports(report);
      const [entry] = await listSessionCatalog(repo, DEFAULT_CONFIG);
      const target = path.join(report.sessionDir, SESSION_SEARCH_FILE);
      await rm(target);
      const external = path.join(repo, "preserve");
      await mkdir(external);
      await writeFile(path.join(external, "evidence.txt"), "preserve");
      await symlink(external, target, process.platform === "win32" ? "junction" : "dir");
      await expect(inspectSessionIndexes(entry, { repair: true })).rejects.toThrow("linked or special");
      expect(await readFile(path.join(external, "evidence.txt"), "utf8")).toBe("preserve");
    } finally {
      await removeTempDir(repo);
    }
  });

  it("leaves indexes untouched when canonical report validation fails", async () => {
    const repo = await createTempDir("abb-index-");
    try {
      const report = makeReport(repo);
      await writeReports(report);
      const [entry] = await listSessionCatalog(repo, DEFAULT_CONFIG);
      const searchBefore = await readFile(path.join(report.sessionDir, SESSION_SEARCH_FILE));
      await writeFile(path.join(report.sessionDir, "session.json"), "corrupted");
      await expect(inspectSessionIndexes(entry, { repair: true })).rejects.toThrow();
      expect(await readFile(path.join(report.sessionDir, SESSION_SEARCH_FILE))).toEqual(searchBefore);
    } finally {
      await removeTempDir(repo);
    }
  });
});

function makeReport(repo: string) {
  const id = "session-index-test";
  const startedAt = "2026-01-01T00:00:00.000Z";
  return buildSessionReport(
    { id, repoRoot: repo, sessionDir: path.join(repo, DEFAULT_CONFIG.sessionDir, id), startedAt },
    "2026-01-01T00:01:00.000Z",
    "test",
    [],
    [{ startedAt, endedAt: startedAt, command: "pnpm test", cwd: ".", exitCode: 0, durationMs: 1 }],
    {
      repoRoot: repo,
      statusText: "changed",
      diffSummaryText: "changed",
      changedFiles: [{ path: "src/a.ts", status: "modified" }],
    },
    [],
    []
  );
}
