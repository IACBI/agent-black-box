import { mkdir, open, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/config/defaults.js";
import { buildSessionReport } from "../src/reports/markdown.js";
import { writeReports } from "../src/reports/reportWriter.js";
import { listSessionCatalog } from "../src/session/sessionCatalog.js";
import {
  applySessionRetention,
  archiveSessionRetention,
  planSessionRetention,
  renderSessionArchivePlan,
  renderSessionRetentionPlan,
  retentionDateForDays,
} from "../src/session/sessionRetention.js";
import { getActiveSessionPath } from "../src/session/sessionManager.js";
import { INLINE_REPORT_BYTES } from "../src/session/reportStorage.js";
import type { FileEvent } from "../src/types.js";
import { pathExists } from "../src/utils/files.js";
import { createTempDir, removeTempDir } from "./testUtils.js";

describe("session retention", () => {
  it("only selects older complete sessions and leaves preview read-only", async () => {
    const repo = await createTempDir("abb-retention-");
    try {
      await makeSession(repo, "session-old", "2026-01-01T00:00:00.000Z");
      await makeSession(repo, "session-new", "2026-01-03T00:00:00.000Z");
      const incomplete = path.join(repo, ".agent-black-box", "sessions", "session-incomplete");
      await mkdir(incomplete, { recursive: true });
      await writeFile(
        path.join(incomplete, "session-start.json"),
        JSON.stringify({ id: "session-incomplete", startedAt: "2026-01-01T00:00:00.000Z" })
      );
      const corrupt = path.join(repo, ".agent-black-box", "sessions", "session-corrupt");
      await mkdir(corrupt);
      const interrupted = path.join(repo, ".agent-black-box", "sessions", ".pruning-session-interrupted");
      await mkdir(interrupted);
      await writeFile(path.join(interrupted, "preserve.txt"), "review before removing", "utf8");

      const entries = await listSessionCatalog(repo, DEFAULT_CONFIG);
      const plan = planSessionRetention(entries, "2026-01-04");
      expect(plan.sessions.map((session) => session.id)).toEqual(["session-old"]);
      expect(renderSessionRetentionPlan(plan)).toContain("1 session(s) eligible");
      expect(
        await readFile(path.join(repo, ".agent-black-box", "sessions", "session-old", "session.json"), "utf8")
      ).toContain("session-old");
      expect(entries.find((entry) => entry.id === "session-incomplete")?.state).toBe("incomplete");
      expect(entries.find((entry) => entry.id === "session-corrupt")?.state).toBe("corrupt");

      await applySessionRetention(repo, DEFAULT_CONFIG, plan);
      expect((await listSessionCatalog(repo, DEFAULT_CONFIG)).map((entry) => entry.id)).toEqual([
        "session-new",
        "session-incomplete",
        "session-corrupt",
      ]);
      expect(await readFile(path.join(interrupted, "preserve.txt"), "utf8")).toBe("review before removing");
    } finally {
      await removeTempDir(repo);
    }
  });

  it("refuses changed history and active state before deletion", async () => {
    const repo = await createTempDir("abb-retention-");
    try {
      await makeSession(repo, "session-old", "2026-01-01T00:00:00.000Z");
      await makeSession(repo, "session-new", "2026-01-03T00:00:00.000Z");
      const plan = planSessionRetention(await listSessionCatalog(repo, DEFAULT_CONFIG), "2026-01-04");
      await writeFile(getActiveSessionPath(repo, DEFAULT_CONFIG), "{}", "utf8");
      await expect(applySessionRetention(repo, DEFAULT_CONFIG, plan)).rejects.toThrow("active");
      await rm(getActiveSessionPath(repo, DEFAULT_CONFIG));

      await makeSession(repo, "session-middle", "2026-01-02T00:00:00.000Z");
      await expect(applySessionRetention(repo, DEFAULT_CONFIG, plan)).rejects.toThrow("changed since the preview");
      expect(
        (await listSessionCatalog(repo, DEFAULT_CONFIG)).filter((entry) => entry.state === "complete")
      ).toHaveLength(3);
    } finally {
      await removeTempDir(repo);
    }
  });

  it.each(["healthy", "corrupt"])(
    "checks large report records before retention (%s)",
    async (kind) => {
      const repo = await createTempDir("abb-retention-");
      try {
        const event: FileEvent = {
          timestamp: "2026-01-01T00:00:00.000Z",
          eventType: "change",
          path: `src/${"x".repeat(30_000)}.ts`,
        };
        const events = Array.from({ length: 1_200 }, () => event);
        await makeSession(repo, "session-old", "2026-01-01T00:00:00.000Z", events);
        await makeSession(repo, "session-new", "2026-01-03T00:00:00.000Z");
        const sessionDir = path.join(repo, DEFAULT_CONFIG.sessionDir, "session-old");
        const reportPath = path.join(sessionDir, "session.json");
        const eventPath = path.join(sessionDir, "events.ndjson");
        const eventLogBytes = (await stat(eventPath)).size;
        expect((await stat(reportPath)).size).toBeGreaterThan(INLINE_REPORT_BYTES);

        if (kind === "corrupt") {
          const handle = await open(eventPath, "r+");
          try {
            await handle.write(Buffer.from("y"), 0, 1, JSON.stringify(event).indexOf("x"));
          } finally {
            await handle.close();
          }
        }

        const plan = planSessionRetention(await listSessionCatalog(repo, DEFAULT_CONFIG), "2026-01-04");
        if (kind === "corrupt") {
          await expect(applySessionRetention(repo, DEFAULT_CONFIG, plan)).rejects.toThrow("no longer match");
          expect(await pathExists(reportPath)).toBe(true);
          expect((await stat(eventPath)).size).toBe(eventLogBytes);
        } else {
          await applySessionRetention(repo, DEFAULT_CONFIG, plan);
          expect(await pathExists(sessionDir)).toBe(false);
        }
        expect(await pathExists(path.join(repo, DEFAULT_CONFIG.sessionDir, "session-new", "session.json"))).toBe(true);
      } finally {
        await removeTempDir(repo);
      }
    },
    120_000
  );

  it("rejects invalid cutoffs and keep counts", () => {
    expect(() => planSessionRetention([], "2026-02-30")).toThrow("valid date");
    expect(() => planSessionRetention([], "2026-01-01", 0)).toThrow("positive integer");
    expect(retentionDateForDays(30, new Date("2026-09-28T23:59:00.000Z"))).toBe("2026-08-29");
    expect(() => retentionDateForDays(0)).toThrow("Retention days");
  });

  it("copies and verifies eligible sessions without removing originals", async () => {
    const repo = await createTempDir("abb-archive-");
    try {
      await makeSession(repo, "session-old", "2026-01-01T00:00:00.000Z");
      await makeSession(repo, "session-new", "2026-01-03T00:00:00.000Z");
      const archiveDir = path.join(repo, ".agent-black-box", "archive");
      const plan = planSessionRetention(await listSessionCatalog(repo, DEFAULT_CONFIG), "2026-01-04");
      expect(renderSessionArchivePlan(plan, archiveDir)).toContain("Original sessions remain in place");

      await archiveSessionRetention(repo, DEFAULT_CONFIG, plan, archiveDir);
      const source = path.join(repo, ".agent-black-box", "sessions", "session-old", "session.json");
      const copied = path.join(archiveDir, "session-old", "session.json");
      expect(await readFile(copied, "utf8")).toBe(await readFile(source, "utf8"));
      expect(
        JSON.parse(await readFile(path.join(archiveDir, "session-old", ".abb-archive-complete.json"), "utf8"))
      ).toMatchObject({
        archiveVersion: 1,
        id: "session-old",
      });
      expect((await listSessionCatalog(repo, DEFAULT_CONFIG)).map((entry) => entry.id)).toContain("session-old");
      await expect(archiveSessionRetention(repo, DEFAULT_CONFIG, plan, archiveDir)).rejects.toThrow("already contains");
    } finally {
      await removeTempDir(repo);
    }
  });

  it("rejects an archive destination inside the session root", async () => {
    const repo = await createTempDir("abb-archive-");
    try {
      await makeSession(repo, "session-old", "2026-01-01T00:00:00.000Z");
      await makeSession(repo, "session-new", "2026-01-03T00:00:00.000Z");
      const plan = planSessionRetention(await listSessionCatalog(repo, DEFAULT_CONFIG), "2026-01-04");
      await expect(
        archiveSessionRetention(repo, DEFAULT_CONFIG, plan, path.join(repo, ".agent-black-box", "sessions", "archive"))
      ).rejects.toThrow("outside the session root");
    } finally {
      await removeTempDir(repo);
    }
  });

  it("refuses to archive linked session content", async () => {
    const repo = await createTempDir("abb-archive-");
    try {
      await makeSession(repo, "session-old", "2026-01-01T00:00:00.000Z");
      await makeSession(repo, "session-new", "2026-01-03T00:00:00.000Z");
      const outside = path.join(repo, "outside");
      await mkdir(outside);
      await writeFile(path.join(outside, "keep.txt"), "keep", "utf8");
      await symlink(
        outside,
        path.join(repo, ".agent-black-box", "sessions", "session-old", "linked"),
        process.platform === "win32" ? "junction" : "dir"
      );
      const plan = planSessionRetention(await listSessionCatalog(repo, DEFAULT_CONFIG), "2026-01-04");
      await expect(
        archiveSessionRetention(repo, DEFAULT_CONFIG, plan, path.join(repo, ".agent-black-box", "archive"))
      ).rejects.toThrow("linked or special file");
      expect(await readFile(path.join(outside, "keep.txt"), "utf8")).toBe("keep");
    } finally {
      await removeTempDir(repo);
    }
  });

  it("refuses linked content and keeps external files", async () => {
    const repo = await createTempDir("abb-retention-");
    try {
      await makeSession(repo, "session-old", "2026-01-01T00:00:00.000Z");
      await makeSession(repo, "session-new", "2026-01-03T00:00:00.000Z");
      const external = path.join(repo, "outside-session");
      await mkdir(external);
      await writeFile(path.join(external, "keep.txt"), "keep", "utf8");
      await symlink(
        external,
        path.join(repo, ".agent-black-box", "sessions", "session-old", "linked"),
        process.platform === "win32" ? "junction" : "dir"
      );
      const plan = planSessionRetention(await listSessionCatalog(repo, DEFAULT_CONFIG), "2026-01-04");
      await expect(applySessionRetention(repo, DEFAULT_CONFIG, plan)).rejects.toThrow("linked or special file");
      expect(await readFile(path.join(external, "keep.txt"), "utf8")).toBe("keep");
    } finally {
      await removeTempDir(repo);
    }
  });
});

async function makeSession(repoRoot: string, id: string, startedAt: string, events: FileEvent[] = []): Promise<void> {
  const sessionDir = path.join(repoRoot, ".agent-black-box", "sessions", id);
  const report = buildSessionReport(
    { id, repoRoot, sessionDir, startedAt },
    new Date(Date.parse(startedAt) + 60_000).toISOString(),
    "test",
    events,
    [],
    { repoRoot, branch: "main", statusText: "", diffSummaryText: "", changedFiles: [] },
    [],
    []
  );
  if (events.length > 0) {
    await mkdir(sessionDir, { recursive: true });
    await writeFile(
      path.join(sessionDir, "events.ndjson"),
      `${events.map((event) => JSON.stringify(event)).join("\n")}\n`
    );
    await writeFile(path.join(sessionDir, "commands.ndjson"), "");
  }
  await writeReports(report);
}
