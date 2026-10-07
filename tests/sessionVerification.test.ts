import { appendFile, mkdir, open, readFile, rm, stat, truncate, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG } from "../src/config/defaults.js";
import { buildSessionReport } from "../src/reports/markdown.js";
import { writeReports } from "../src/reports/reportWriter.js";
import { INLINE_REPORT_BYTES, REPORT_REPLAY_FILE } from "../src/session/reportStorage.js";
import {
  buildSessionMetadata,
  listSessionCatalog,
  verifyCatalogSessionReportFile,
} from "../src/session/sessionCatalog.js";
import * as catalog from "../src/session/sessionCatalog.js";
import * as files from "../src/utils/files.js";
import * as ndjson from "../src/session/ndjson.js";
import { createSession, finalizeSession } from "../src/session/sessionManager.js";
import {
  getSessionVerificationLimits,
  renderSessionVerification,
  VERIFICATION_STREAM_WORKING_BYTES,
  verifySessions,
} from "../src/session/sessionVerification.js";
import { createTempDir, initGitRepo, removeTempDir } from "./testUtils.js";

async function verifyRepository(repo: string) {
  return verifySessions(await listSessionCatalog(repo, DEFAULT_CONFIG));
}

describe("session verification", () => {
  it.each([0, 7, 8.5, 4097, NaN, Infinity])(
    "rejects invalid memory budgets %s before inspecting sessions",
    async (memoryBudgetMb) => {
      await expect(verifySessions([], { memoryBudgetMb })).rejects.toThrow("integer between 8 and 4096");
    }
  );

  it.each([0, 1.5, 17, NaN, Infinity])(
    "rejects invalid concurrency %s before inspecting sessions",
    async (concurrency) => {
      await expect(verifySessions([], { concurrency })).rejects.toThrow("integer between 1 and 16");
    }
  );

  it("allocates deterministic input quotas and preserves unbudgeted defaults", () => {
    expect(getSessionVerificationLimits()).toEqual({
      concurrency: 4,
      streamWorkingBytes: VERIFICATION_STREAM_WORKING_BYTES,
    });
    expect(getSessionVerificationLimits({ concurrency: 16 }).concurrency).toBe(16);
    const minimum = getSessionVerificationLimits({ memoryBudgetMb: 8, concurrency: 16 });
    expect(minimum.concurrency).toBe(1);
    expect(minimum.maxMaterializedBytes).toBe((8 * 1024 * 1024 - VERIFICATION_STREAM_WORKING_BYTES) / 2);
    const maximum = getSessionVerificationLimits({ memoryBudgetMb: 4096, concurrency: 16 });
    expect(maximum.concurrency).toBe(16);
    expect(16 * (2 * maximum.maxMaterializedBytes! + maximum.streamWorkingBytes)).toBeLessThanOrEqual(
      4096 * 1024 * 1024
    );
  });

  it.each([
    { memoryBudgetMb: 8, expected: 1 },
    { memoryBudgetMb: 32, expected: 4 },
  ])("limits aggregate verification work under a $memoryBudgetMb MiB budget", async ({ memoryBudgetMb, expected }) => {
    let active = 0;
    let maximumActive = 0;
    const quotas: Array<number | undefined> = [];
    const verifier = vi.spyOn(catalog, "verifyCatalogSessionReportFile").mockImplementation(async (_entry, options) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      quotas.push(options?.maxMaterializedBytes);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active -= 1;
    });
    try {
      const entries = Array.from({ length: 8 }, (_, index) => ({
        id: `session-${index}`,
        sessionDir: path.resolve(".cache", "nonexistent-verification", `${index}`),
        state: "complete" as const,
      }));
      const summary = await verifySessions(entries, { memoryBudgetMb, concurrency: 16 });
      expect(maximumActive).toBe(expected);
      expect(summary.verified).toBe(8);
      expect(summary.sessions.map((entry) => entry.id)).toEqual(entries.map((entry) => entry.id));
      expect(new Set(quotas)).toEqual(
        new Set([getSessionVerificationLimits({ memoryBudgetMb, concurrency: 16 }).maxMaterializedBytes])
      );
    } finally {
      verifier.mockRestore();
    }
  });

  it("refuses oversized inline input before parsing it while continuing other sessions", async () => {
    const repo = await createTempDir("abb-verify-budget-");
    let restoreReader: (() => void) | undefined;
    try {
      const limits = getSessionVerificationLimits({ memoryBudgetMb: 8, concurrency: 1 });
      for (const id of ["session-small", "session-large"]) {
        const sessionDir = path.join(repo, DEFAULT_CONFIG.sessionDir, id);
        const timestamp = "2026-01-05T00:00:00.000Z";
        const report = buildSessionReport(
          { id, repoRoot: repo, sessionDir, startedAt: timestamp },
          timestamp,
          "test",
          [],
          [],
          {
            repoRoot: repo,
            statusText: id === "session-large" ? "x".repeat(limits.maxMaterializedBytes! + 1) : "clean",
            diffSummaryText: "none",
            changedFiles: [],
          },
          [],
          []
        );
        await mkdir(sessionDir, { recursive: true });
        await writeFile(path.join(sessionDir, "session.json"), JSON.stringify(report));
        await writeFile(path.join(sessionDir, "session-metadata.json"), JSON.stringify(buildSessionMetadata(report)));
      }
      const entries = await listSessionCatalog(repo, DEFAULT_CONFIG, {
        maxMaterializedBytes: limits.maxMaterializedBytes,
      });
      const originalRead = files.readJsonFileLimited;
      const reader = vi.spyOn(files, "readJsonFileLimited").mockImplementation((filePath, maxBytes) => {
        expect(filePath).not.toContain("session-large");
        return originalRead(filePath, maxBytes);
      });
      restoreReader = () => reader.mockRestore();
      const summary = await verifySessions(entries, { memoryBudgetMb: 8, concurrency: 1 });
      expect(summary).toMatchObject({ verified: 1, failed: 1 });
      expect(summary.sessions.find((entry) => entry.id === "session-large")?.message).toContain("working-data policy");
      expect(entries.every((entry) => entry.state === "complete")).toBe(true);
    } finally {
      restoreReader?.();
      await removeTempDir(repo);
    }
  });
  it("renders untrusted fields without emitting terminal controls or additional rows", () => {
    const rendered = renderSessionVerification({
      verified: 0,
      failed: 1,
      skipped: 0,
      sessions: [
        {
          id: "session-\u001b[2J\ninjected",
          status: "failed",
          message: "damaged\rreport\u009b",
          missingReports: ["summary\nforged.md", "risks.md"],
        },
      ],
    });

    expect(rendered).toContain('"session-\\u001b[2J\\ninjected"');
    expect(rendered).toContain('"damaged\\rreport\\u009b"');
    expect(rendered).toContain('"summary\\nforged.md", risks.md');
    expect(rendered).not.toContain("\u001b");
    expect(rendered).not.toContain("\u009b");
    expect(rendered.split("\n")).toHaveLength(7);
  });

  it("verifies a finalized session without missing reports", async () => {
    const repo = await createTempDir("abb-verify-");
    try {
      initGitRepo(repo);
      const session = await createSession(repo, DEFAULT_CONFIG);
      await finalizeSession(session, DEFAULT_CONFIG, "test");

      const summary = await verifyRepository(repo);

      expect(summary).toMatchObject({ verified: 1, failed: 0, skipped: 0 });
      expect(summary.sessions).toEqual([{ id: session.id, status: "verified" }]);
    } finally {
      await removeTempDir(repo);
    }
  });

  it("reports absent derived reports without failing the session", async () => {
    const repo = await createTempDir("abb-verify-missing-");
    try {
      initGitRepo(repo);
      const session = await createSession(repo, DEFAULT_CONFIG);
      await finalizeSession(session, DEFAULT_CONFIG, "test");
      await rm(path.join(session.sessionDir, "summary.md"));
      await rm(path.join(session.sessionDir, "risks.md"));

      const summary = await verifyRepository(repo);

      expect(summary.failed).toBe(0);
      expect(summary.sessions[0]).toMatchObject({
        status: "verified",
        missingReports: ["summary.md", "risks.md"],
      });
      expect(renderSessionVerification(summary)).toContain("missing reports: summary.md, risks.md");
    } finally {
      await removeTempDir(repo);
    }
  });

  it("fails a session whose stored report was damaged", async () => {
    const repo = await createTempDir("abb-verify-damaged-");
    try {
      initGitRepo(repo);
      const session = await createSession(repo, DEFAULT_CONFIG);
      await finalizeSession(session, DEFAULT_CONFIG, "test");
      await truncate(path.join(session.sessionDir, "session.json"), 20);

      const summary = await verifyRepository(repo);

      expect(summary).toMatchObject({ verified: 0, failed: 1, skipped: 0 });
      expect(summary.sessions[0]).toMatchObject({ id: session.id, status: "failed" });
      expect(summary.sessions[0]?.message).toBeTruthy();
    } finally {
      await removeTempDir(repo);
    }
  });

  it("skips incomplete sessions and fails corrupt catalog entries", async () => {
    const repo = await createTempDir("abb-verify-states-");
    try {
      initGitRepo(repo);
      const sessionRoot = path.join(repo, DEFAULT_CONFIG.sessionDir);
      const incompleteId = "session-2026-01-04T00-00-00-000Z";
      const corruptId = "session-2026-01-02T00-00-00-000Z";
      await mkdir(path.join(sessionRoot, incompleteId), { recursive: true });
      await writeFile(
        path.join(sessionRoot, incompleteId, "session-start.json"),
        JSON.stringify({ id: incompleteId, startedAt: "2026-01-04T00:00:00.000Z" })
      );
      await mkdir(path.join(sessionRoot, corruptId), { recursive: true });
      await writeFile(path.join(sessionRoot, corruptId, "session.json"), JSON.stringify({ id: corruptId }));

      const summary = await verifyRepository(repo);

      expect(summary).toMatchObject({ verified: 0, failed: 1, skipped: 1 });
      expect(summary.sessions.map((session) => [session.id, session.status])).toEqual([
        [incompleteId, "skipped"],
        [corruptId, "failed"],
      ]);
      expect(renderSessionVerification(summary)).toContain("Verified: 0, failed: 1, skipped: 1.");
    } finally {
      await removeTempDir(repo);
    }
  });

  it("fails a large replay report when an event log changes without changing its size", async () => {
    const repo = await createTempDir("abb-verify-replay-");
    const materializedRead = vi.spyOn(ndjson, "readNdjsonRecords");
    try {
      const id = "session-large-replay";
      const sessionDir = path.join(repo, DEFAULT_CONFIG.sessionDir, id);
      const timestamp = "2026-01-05T00:00:00.000Z";
      const event = { timestamp, eventType: "change" as const, path: `src/${"x".repeat(30_000)}.ts`, extra: "a" };
      const report = buildSessionReport(
        { id, repoRoot: repo, sessionDir, startedAt: timestamp },
        timestamp,
        "test",
        Array.from({ length: 1_200 }, () => event),
        [],
        { repoRoot: repo, statusText: "clean", diffSummaryText: "no changes", changedFiles: [] },
        [],
        []
      );
      await mkdir(sessionDir, { recursive: true });
      const eventPath = path.join(sessionDir, "events.ndjson");
      const eventLine = JSON.stringify(event);
      const invalidEventLine = JSON.stringify({ ...event, timestamp: "invalid" });
      const command = {
        startedAt: timestamp,
        endedAt: timestamp,
        command: "node --version",
        cwd: ".",
        exitCode: 0,
        durationMs: 1,
        extra: "retained",
      };
      report.commands = [command];
      report.commandCapture.implemented = true;
      report.integrity.discardedFileEventLines = 1;
      await writeFile(eventPath, `${invalidEventLine}\n${report.events.map(() => eventLine).join("\n")}\n`);
      await writeFile(path.join(sessionDir, "commands.ndjson"), `${JSON.stringify(command)}\n`);
      await writeReports(report);
      expect((await stat(path.join(sessionDir, "session.json"))).size).toBeGreaterThan(INLINE_REPORT_BYTES);
      expect(await verifyRepository(repo)).toMatchObject({ verified: 1, failed: 0 });

      const limits = getSessionVerificationLimits({ memoryBudgetMb: 8 });
      const metadataPath = path.join(sessionDir, "session-metadata.json");
      const metadataContents = await readFile(metadataPath);
      await rm(metadataPath);
      const budgetedCatalog = await listSessionCatalog(repo, DEFAULT_CONFIG, {
        maxMaterializedBytes: limits.maxMaterializedBytes,
      });
      await writeFile(metadataPath, metadataContents);
      expect(budgetedCatalog[0]).toMatchObject({
        id,
        state: "complete",
        startedAt: timestamp,
        commandCount: 1,
        riskScore: report.riskSummary.score,
      });
      expect(budgetedCatalog[0].metadataUnavailable).toBeUndefined();
      expect(await verifySessions(budgetedCatalog, { memoryBudgetMb: 8 })).toMatchObject({ verified: 1, failed: 0 });
      const replayPath = path.join(sessionDir, REPORT_REPLAY_FILE);
      const replayContents = await readFile(replayPath);
      await appendFile(replayPath, " ".repeat(limits.maxMaterializedBytes! + 1));
      expect((await verifySessions(budgetedCatalog, { memoryBudgetMb: 8 })).sessions[0]).toMatchObject({
        status: "failed",
        message: expect.stringContaining("session-replay.json requires"),
      });
      expect(await verifyRepository(repo)).toMatchObject({ verified: 1, failed: 0 });
      await writeFile(replayPath, replayContents);

      const before = await stat(eventPath);
      const handle = await open(eventPath, "r+");
      try {
        const firstAcceptedLineOffset = Buffer.byteLength(invalidEventLine) + 1;
        // Extra fields are retained in the canonical digest even though the event guard does not inspect them.
        const extraOffset = firstAcceptedLineOffset + eventLine.indexOf('"extra":"a"') + '"extra":"'.length;
        await handle.write(Buffer.from("b"), 0, 1, extraOffset);
        expect(await verifyRepository(repo)).toMatchObject({ verified: 0, failed: 1 });
        await handle.write(Buffer.from("a"), 0, 1, extraOffset);

        // A same-size formerly invalid line becomes accepted: both counts and discarded-line totals must be checked.
        const invalidDateOffset = invalidEventLine.indexOf("invalid");
        await handle.write(Buffer.from("2026-01"), 0, 7, invalidDateOffset);
        expect(await verifyRepository(repo)).toMatchObject({ verified: 0, failed: 1 });
        await handle.write(Buffer.from("invalid"), 0, 7, invalidDateOffset);

        await handle.write(Buffer.from("y"), 0, 1, firstAcceptedLineOffset + eventLine.indexOf("src/") + 4);
      } finally {
        await handle.close();
      }
      expect((await stat(eventPath)).size).toBe(before.size);

      const summary = await verifyRepository(repo);
      expect(summary).toMatchObject({ verified: 0, failed: 1, skipped: 0 });
      expect(summary.sessions[0]?.message).toContain("event logs no longer match");
      const [entry] = await listSessionCatalog(repo, DEFAULT_CONFIG);
      // Archive and recovery keep their deliberately lighter digest-and-size check.
      await expect(verifyCatalogSessionReportFile(entry)).resolves.toBeUndefined();
      expect(materializedRead).not.toHaveBeenCalled();
    } finally {
      materializedRead.mockRestore();
      await removeTempDir(repo);
    }
  }, 120_000);

  it("renders an explicit message when there are no sessions", async () => {
    expect(renderSessionVerification(await verifySessions([]))).toBe("No Agent Black Box sessions were found.\n");
  });
});
