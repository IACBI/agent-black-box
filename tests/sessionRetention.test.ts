import { mkdir, open, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG } from "../src/config/defaults.js";
import { buildSessionReport } from "../src/reports/markdown.js";
import { writeReports } from "../src/reports/reportWriter.js";
import { listSessionCatalog, SESSION_METADATA_FILE } from "../src/session/sessionCatalog.js";
import {
  applySessionRetention,
  archiveSessionRetention,
  inspectSessionArchives,
  planSessionRetention,
  renderSessionArchivePlan,
  renderSessionRetentionPlan,
  resolveArchiveDestination,
  retentionDateForDays,
} from "../src/session/sessionRetention.js";
import { getActiveSessionPath } from "../src/session/sessionManager.js";
import { INLINE_REPORT_BYTES } from "../src/session/reportStorage.js";
import type { FileEvent } from "../src/types.js";
import { pathExists } from "../src/utils/files.js";
import { createTempDir, removeTempDir } from "./testUtils.js";

const archiveRace = vi.hoisted(() => ({ onLstat: undefined as ((filePath: string) => Promise<void>) | undefined }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    lstat: vi.fn(async (filePath: import("node:fs").PathLike, options?: import("node:fs").StatOptions) => {
      await archiveRace.onLstat?.(String(filePath));
      return actual.lstat(filePath, options);
    }),
  };
});

describe("session retention", () => {
  it.each(["prune", "archive", "inspection"])(
    "rejects a stale kept timestamp that would select the true newest session for %s",
    async (operation) => {
      const repo = await createTempDir("abb-retention-kept-timestamp-");
      try {
        await makeSession(repo, "session-old", "2026-01-01T00:00:00.000Z");
        await makeSession(repo, "session-new", "2026-01-03T00:00:00.000Z");
        const oldDirectory = path.join(repo, DEFAULT_CONFIG.sessionDir, "session-old");
        const metadataPath = path.join(oldDirectory, SESSION_METADATA_FILE);
        const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
        await writeFile(metadataPath, JSON.stringify({ ...metadata, startedAt: "2026-01-10T00:00:00.000Z" }));
        const plan = planSessionRetention(await listSessionCatalog(repo, DEFAULT_CONFIG), "2026-01-04");
        expect(plan.sessions.map((session) => session.id)).toEqual(["session-new"]);
        const archiveDir = path.join(repo, "archive");
        const apply =
          operation === "prune"
            ? applySessionRetention(repo, DEFAULT_CONFIG, plan)
            : operation === "archive"
              ? archiveSessionRetention(repo, DEFAULT_CONFIG, plan, archiveDir)
              : inspectSessionArchives(repo, DEFAULT_CONFIG, plan, archiveDir);
        await expect(apply).rejects.toThrow("inconsistent catalog timestamps");
        expect(await pathExists(path.join(oldDirectory, "session.json"))).toBe(true);
        expect(await pathExists(path.join(repo, DEFAULT_CONFIG.sessionDir, "session-new", "session.json"))).toBe(true);
        expect(await pathExists(archiveDir)).toBe(false);
      } finally {
        await removeTempDir(repo);
      }
    }
  );

  it("refuses a destination created after preflight unless resume is explicit", async () => {
    const repo = await createTempDir("abb-archive-race-");
    try {
      await makeSession(repo, "session-old", "2026-01-01T00:00:00.000Z");
      await makeSession(repo, "session-new", "2026-01-03T00:00:00.000Z");
      const archiveDir = path.join(repo, "archive");
      const destination = path.join(archiveDir, "session-old");
      const plan = planSessionRetention(await listSessionCatalog(repo, DEFAULT_CONFIG), "2026-01-04");
      let ownershipChecks = 0;
      archiveRace.onLstat = async (filePath) => {
        if (filePath === getActiveSessionPath(repo, DEFAULT_CONFIG) && ++ownershipChecks === 2) {
          // Interleave after the existing-ID preflight and before the copy loop's destination check.
          await mkdir(destination);
        }
      };
      await expect(archiveSessionRetention(repo, DEFAULT_CONFIG, plan, archiveDir)).rejects.toMatchObject({
        code: "EEXIST",
      });
      archiveRace.onLstat = undefined;
      expect(await pathExists(path.join(destination, "session.json"))).toBe(false);
      await archiveSessionRetention(repo, DEFAULT_CONFIG, plan, archiveDir, { resume: true });
      expect((await inspectSessionArchives(repo, DEFAULT_CONFIG, plan, archiveDir))[0].status).toBe("complete");
    } finally {
      archiveRace.onLstat = undefined;
      await removeTempDir(repo);
    }
  });

  it.each(["prune", "archive", "inspection"])("rejects stale catalog timestamps before %s", async (operation) => {
    const repo = await createTempDir("abb-retention-timestamp-");
    try {
      await makeSession(repo, "session-old", "2026-01-10T00:00:00.000Z");
      await makeSession(repo, "session-new", "2026-01-11T00:00:00.000Z");
      const source = path.join(repo, DEFAULT_CONFIG.sessionDir, "session-old");
      const metadataPath = path.join(source, SESSION_METADATA_FILE);
      const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
      await writeFile(metadataPath, JSON.stringify({ ...metadata, startedAt: "2026-01-01T00:00:00.000Z" }));
      const plan = planSessionRetention(await listSessionCatalog(repo, DEFAULT_CONFIG), "2026-01-04");
      expect(plan.sessions.map((session) => session.id)).toEqual(["session-old"]);
      const archiveDir = path.join(repo, "archive");
      const apply =
        operation === "prune"
          ? applySessionRetention(repo, DEFAULT_CONFIG, plan)
          : operation === "archive"
            ? archiveSessionRetention(repo, DEFAULT_CONFIG, plan, archiveDir)
            : inspectSessionArchives(repo, DEFAULT_CONFIG, plan, archiveDir);
      await expect(apply).rejects.toThrow("inconsistent catalog timestamps");
      expect(await pathExists(path.join(source, "session.json"))).toBe(true);
      expect(await pathExists(archiveDir)).toBe(false);
    } finally {
      await removeTempDir(repo);
    }
  });

  it("inspects and resumes a matching partial archive without replacing existing files", async () => {
    const repo = await createTempDir("abb-archive-resume-");
    try {
      await makeSession(repo, "session-old", "2026-01-01T00:00:00.000Z");
      await makeSession(repo, "session-new", "2026-01-03T00:00:00.000Z");
      const source = path.join(repo, DEFAULT_CONFIG.sessionDir, "session-old");
      const archiveDir = path.join(repo, "archive");
      const destination = path.join(archiveDir, "session-old");
      const plan = planSessionRetention(await listSessionCatalog(repo, DEFAULT_CONFIG), "2026-01-04");
      expect(await inspectSessionArchives(repo, DEFAULT_CONFIG, plan, archiveDir)).toEqual([
        { id: "session-old", status: "missing" },
      ]);
      expect(await pathExists(archiveDir)).toBe(false);
      await mkdir(destination, { recursive: true });
      await mkdir(path.join(source, "nested"));
      await writeFile(path.join(source, "nested", "notes.txt"), "review evidence");
      const existingPath = path.join(destination, "summary.md");
      await writeFile(existingPath, await readFile(path.join(source, "summary.md")));
      const before = await stat(existingPath);
      expect(await inspectSessionArchives(repo, DEFAULT_CONFIG, plan, archiveDir)).toEqual([
        { id: "session-old", status: "resumable" },
      ]);
      await archiveSessionRetention(repo, DEFAULT_CONFIG, plan, archiveDir, { resume: true });
      expect((await stat(existingPath)).mtimeMs).toBe(before.mtimeMs);
      expect(await readFile(path.join(destination, "nested", "notes.txt"), "utf8")).toBe("review evidence");
      expect(await inspectSessionArchives(repo, DEFAULT_CONFIG, plan, archiveDir)).toEqual([
        { id: "session-old", status: "complete" },
      ]);
      await expect(
        archiveSessionRetention(repo, DEFAULT_CONFIG, plan, archiveDir, { resume: true })
      ).resolves.toBeUndefined();
      expect(await pathExists(path.join(source, "session.json"))).toBe(true);
    } finally {
      await removeTempDir(repo);
    }
  });

  it.each(["different bytes", "extra file", "invalid marker", "linked directory"])(
    "refuses an unsafe archive resume (%s)",
    async (kind) => {
      const repo = await createTempDir("abb-archive-conflict-");
      try {
        await makeSession(repo, "session-old", "2026-01-01T00:00:00.000Z");
        await makeSession(repo, "session-new", "2026-01-03T00:00:00.000Z");
        const archiveDir = path.join(repo, "archive");
        const destination = path.join(archiveDir, "session-old");
        const plan = planSessionRetention(await listSessionCatalog(repo, DEFAULT_CONFIG), "2026-01-04");
        await mkdir(destination, { recursive: true });
        if (kind === "different bytes") {
          await writeFile(path.join(destination, "session.json"), "divergent copy");
        } else if (kind === "extra file") {
          await writeFile(path.join(destination, "extra.txt"), "preserve");
        } else if (kind === "invalid marker") {
          await rm(destination, { recursive: true });
          await archiveSessionRetention(repo, DEFAULT_CONFIG, plan, archiveDir);
          await writeFile(path.join(destination, ".abb-archive-complete.json"), "null");
        } else {
          await symlink(repo, path.join(destination, "linked"), process.platform === "win32" ? "junction" : "dir");
        }
        expect((await inspectSessionArchives(repo, DEFAULT_CONFIG, plan, archiveDir))[0].status).toBe("conflict");
        await expect(archiveSessionRetention(repo, DEFAULT_CONFIG, plan, archiveDir, { resume: true })).rejects.toThrow(
          "cannot be resumed"
        );
        expect(await pathExists(path.join(repo, DEFAULT_CONFIG.sessionDir, "session-old", "session.json"))).toBe(true);
      } finally {
        await removeTempDir(repo);
      }
    }
  );

  it("keeps control-bearing preview fields visible without adding misleading lines", () => {
    const plan = {
      before: "2026-01-04",
      keep: 1,
      sessions: [{ id: "session-old\nforged", startedAt: "2026-01-01T00:00:00.000Z" }],
    };
    const preview = renderSessionRetentionPlan(plan);
    const archive = renderSessionArchivePlan(plan, "archive/\u001b[2J\ncopy");

    expect(preview).toContain('"session-old\\nforged"');
    expect(preview).not.toContain("\nforged");
    expect(archive).toContain('Archive destination: "archive/\\u001b[2J\\ncopy"');
    expect(archive).not.toContain("\u001b");
    expect(archive).not.toContain("\ncopy");
    expect(plan.sessions[0]?.id).toBe("session-old\nforged");
  });

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

  describe("resolving the archive destination", () => {
    it("uses an explicit destination as given, even outside the repository", async () => {
      const repo = await createTempDir("abb-archive-dest-");
      const external = await createTempDir("abb-archive-external-");
      try {
        await expect(resolveArchiveDestination(repo, external, ".agent-black-box/archive")).resolves.toBe(external);
      } finally {
        await removeTempDir(repo);
        await removeTempDir(external);
      }
    });

    it("accepts a configured destination inside the repository, existing or not yet created", async () => {
      const repo = await createTempDir("abb-archive-dest-");
      try {
        await mkdir(path.join(repo, "archive"));
        await expect(resolveArchiveDestination(repo, undefined, "archive")).resolves.toBe("archive");
        await expect(resolveArchiveDestination(repo, undefined, ".agent-black-box/new/deep")).resolves.toBe(
          ".agent-black-box/new/deep"
        );
        await expect(resolveArchiveDestination(repo, undefined, undefined)).resolves.toBeUndefined();
      } finally {
        await removeTempDir(repo);
      }
    });

    it("rejects a configured destination that leaves the repository", async () => {
      const repo = await createTempDir("abb-archive-dest-");
      const external = await createTempDir("abb-archive-external-");
      try {
        await expect(resolveArchiveDestination(repo, undefined, external)).rejects.toThrow("inside the repository");
        await expect(resolveArchiveDestination(repo, undefined, "../outside-archive")).rejects.toThrow(
          "inside the repository"
        );
        await expect(resolveArchiveDestination(repo, undefined, "   ")).rejects.toThrow("non-empty local path");
        await expect(resolveArchiveDestination(repo, undefined, "//server/share/archive")).rejects.toThrow(
          "non-empty local path"
        );
      } finally {
        await removeTempDir(repo);
        await removeTempDir(external);
      }
    });

    it("rejects a configured destination that reaches outside the repository through a link", async () => {
      const repo = await createTempDir("abb-archive-dest-");
      const external = await createTempDir("abb-archive-external-");
      try {
        await symlink(external, path.join(repo, "linked"), process.platform === "win32" ? "junction" : "dir");
        await expect(resolveArchiveDestination(repo, undefined, "linked/archive")).rejects.toThrow(
          "inside the repository"
        );
      } finally {
        await removeTempDir(repo);
        await removeTempDir(external);
      }
    });
  });

  it.each([false, true])(
    "rejects a linked archive destination before creating directories (resume=%s)",
    async (resume) => {
      const repo = await createTempDir("abb-archive-linked-destination-");
      try {
        await makeSession(repo, "session-old", "2026-01-01T00:00:00.000Z");
        await makeSession(repo, "session-new", "2026-01-03T00:00:00.000Z");
        const sessionRoot = path.join(repo, DEFAULT_CONFIG.sessionDir);
        const originalReports = await Promise.all(
          ["session-old", "session-new"].map((id) => readFile(path.join(sessionRoot, id, "session.json"), "utf8"))
        );
        const linkedRoot = path.join(repo, "linked-sessions");
        await symlink(sessionRoot, linkedRoot, process.platform === "win32" ? "junction" : "dir");
        const destination = path.join(linkedRoot, "unexpected", "nested");
        const plan = planSessionRetention(await listSessionCatalog(repo, DEFAULT_CONFIG), "2026-01-04");

        await expect(archiveSessionRetention(repo, DEFAULT_CONFIG, plan, destination, { resume })).rejects.toThrow(
          "outside the session root"
        );
        expect(await pathExists(path.join(sessionRoot, "unexpected"))).toBe(false);
        expect(
          await Promise.all(
            ["session-old", "session-new"].map((id) => readFile(path.join(sessionRoot, id, "session.json"), "utf8"))
          )
        ).toEqual(originalReports);
      } finally {
        await removeTempDir(repo);
      }
    }
  );

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
