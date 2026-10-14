import { mkdir, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG } from "../src/config/defaults.js";
import * as reportWriter from "../src/reports/reportWriter.js";
import * as ndjson from "../src/session/ndjson.js";
import { MAX_REPORT_BYTES } from "../src/session/reportStorage.js";
import {
  createSession,
  getActiveSessionPath,
  getCommandsPath,
  getEventsPath,
  getGitBaselinePath,
  getSessionLockPath,
  getStopRequestPath,
  inspectSessionRecoveryState,
  isProcessRunning,
  readCommandEvents,
  readActiveSession,
  readActiveSessionState,
  readFileEvents,
  readFileEventsWithDiagnostics,
  readSessionLock,
  readSessionBaseline,
  readStopRequest,
  recoverActiveSession,
  registerInFlightCommand,
  finalizeSession,
  markCaptureLoss,
  appendCommandEvent,
  appendFileEvent,
} from "../src/session/sessionManager.js";
import { pathExists } from "../src/utils/files.js";
import { createTempDir, initGitRepo, removeTempDir } from "./testUtils.js";

describe("session manager", () => {
  it.each(["unclaimed", "dead-claim"])(
    "serializes %s recovery and protects replacement state",
    async (kind) => {
      const dir = await createTempDir();
      let releaseReports: (() => void) | undefined;
      let recovering: ReturnType<typeof recoverActiveSession> | undefined;
      const writeReports = reportWriter.writeReports;
      const writer = vi.spyOn(reportWriter, "writeReports");
      try {
        initGitRepo(dir);
        const session = await createSession(dir, DEFAULT_CONFIG);
        const stale = { ...session, pid: 999_999 };
        const lock = await readSessionLock(dir, DEFAULT_CONFIG);
        await writeFile(getActiveSessionPath(dir, DEFAULT_CONFIG), JSON.stringify(stale));
        await writeFile(getSessionLockPath(dir, DEFAULT_CONFIG), JSON.stringify({ ...lock, pid: stale.pid }));
        if (kind === "dead-claim") {
          await writeFile(
            path.join(session.sessionDir, "finalization-claim-1.json"),
            JSON.stringify({ ...lock, pid: stale.pid })
          );
        }
        writer.mockImplementationOnce(async (report) => {
          await new Promise<void>((resolve) => {
            releaseReports = resolve;
          });
          await writeReports(report);
        });
        recovering = recoverActiveSession(dir, DEFAULT_CONFIG);
        await vi.waitFor(() => expect(releaseReports).toBeDefined(), { timeout: 10_000 });
        await expect(recoverActiveSession(dir, DEFAULT_CONFIG)).rejects.toThrow("already being finalized");
        await expect(createSession(dir, DEFAULT_CONFIG)).rejects.toThrow("before starting another");
        releaseReports?.();
        await recovering;

        const replacement = await createSession(dir, DEFAULT_CONFIG);
        await expect(finalizeSession(stale, DEFAULT_CONFIG, "delayed-recovery")).rejects.toThrow("ownership changed");
        expect((await readActiveSession(dir, DEFAULT_CONFIG))?.id).toBe(replacement.id);
        expect((await readSessionLock(dir, DEFAULT_CONFIG))?.sessionId).toBe(replacement.id);
        expect((await inspectSessionRecoveryState(dir, DEFAULT_CONFIG)).status).toBe("active");
      } finally {
        releaseReports?.();
        await recovering?.catch(() => undefined);
        writer.mockRestore();
        await removeTempDir(dir);
      }
    },
    30_000
  );

  it("releases failed finalization ownership so the same process can retry recovery", async () => {
    const dir = await createTempDir();
    const writer = vi.spyOn(reportWriter, "writeReports");
    try {
      initGitRepo(dir);
      const session = await createSession(dir, DEFAULT_CONFIG);
      const lock = await readSessionLock(dir, DEFAULT_CONFIG);
      await writeFile(getActiveSessionPath(dir, DEFAULT_CONFIG), JSON.stringify({ ...session, pid: 999_999 }));
      await writeFile(getSessionLockPath(dir, DEFAULT_CONFIG), JSON.stringify({ ...lock, pid: 999_999 }));
      writer.mockRejectedValueOnce(new Error("report write failed"));

      await expect(recoverActiveSession(dir, DEFAULT_CONFIG)).rejects.toThrow("report write failed");
      expect((await readdir(session.sessionDir)).filter((name) => name.startsWith("finalization-claim-"))).toEqual([]);
      expect((await inspectSessionRecoveryState(dir, DEFAULT_CONFIG)).status).toBe("recoverable");
      await expect(recoverActiveSession(dir, DEFAULT_CONFIG)).resolves.toMatchObject({ report: { id: session.id } });
    } finally {
      writer.mockRestore();
      await removeTempDir(dir);
    }
  });

  it.each(["dead", "live", "corrupt"])("handles a %s finalization claim without deleting it", async (kind) => {
    const dir = await createTempDir();
    try {
      initGitRepo(dir);
      const session = await createSession(dir, DEFAULT_CONFIG);
      const lock = await readSessionLock(dir, DEFAULT_CONFIG);
      const claimPath = path.join(session.sessionDir, "finalization-claim-1.json");
      const claimText =
        kind === "corrupt" ? "{not-json}" : JSON.stringify({ ...lock, pid: kind === "live" ? process.pid : 999_999 });
      await writeFile(claimPath, claimText);
      if (kind === "dead") {
        await expect(finalizeSession(session, DEFAULT_CONFIG, "test")).resolves.toMatchObject({ id: session.id });
      } else {
        await expect(finalizeSession(session, DEFAULT_CONFIG, "test")).rejects.toThrow(
          kind === "live" ? "already being finalized" : "claim is unreadable"
        );
        expect((await readActiveSession(dir, DEFAULT_CONFIG))?.id).toBe(session.id);
      }
      expect(await readFile(claimPath, "utf8")).toBe(claimText);
      expect((await readdir(session.sessionDir)).filter((name) => name.startsWith("finalization-claim-"))).toEqual([
        "finalization-claim-1.json",
      ]);
    } finally {
      await removeTempDir(dir);
    }
  });

  it("rejects ambiguous finalization claims when an earlier generation still has a live owner", async () => {
    const dir = await createTempDir();
    try {
      initGitRepo(dir);
      const session = await createSession(dir, DEFAULT_CONFIG);
      const lock = await readSessionLock(dir, DEFAULT_CONFIG);
      await writeFile(path.join(session.sessionDir, "finalization-claim-1.json"), JSON.stringify(lock));
      await writeFile(
        path.join(session.sessionDir, "finalization-claim-2.json"),
        JSON.stringify({ ...lock, pid: 999_999 })
      );

      await expect(finalizeSession(session, DEFAULT_CONFIG, "test")).rejects.toThrow("already being finalized");
      expect((await readActiveSession(dir, DEFAULT_CONFIG))?.id).toBe(session.id);
      expect((await readdir(session.sessionDir)).filter((name) => name.startsWith("finalization-claim-"))).toHaveLength(
        2
      );
    } finally {
      await removeTempDir(dir);
    }
  });

  it("does not treat a process with denied signal permissions as stale", () => {
    const kill = vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("permission denied"), { code: "EPERM" });
    });
    try {
      expect(isProcessRunning(1234)).toBe(true);
      kill.mockImplementation(() => {
        throw Object.assign(new Error("no such process"), { code: "ESRCH" });
      });
      expect(isProcessRunning(1234)).toBe(false);
    } finally {
      kill.mockRestore();
    }
  });

  it("creates a session and active session state", async () => {
    const dir = await createTempDir();
    try {
      initGitRepo(dir);
      const session = await createSession(dir, DEFAULT_CONFIG);

      await expect(pathExists(session.sessionDir)).resolves.toBe(true);
      await expect(pathExists(getEventsPath(session.sessionDir))).resolves.toBe(true);
      await expect(pathExists(getCommandsPath(session.sessionDir))).resolves.toBe(true);
      await expect(pathExists(getGitBaselinePath(session.sessionDir))).resolves.toBe(true);
      await expect(pathExists(getActiveSessionPath(dir, DEFAULT_CONFIG))).resolves.toBe(true);
      await expect(pathExists(getSessionLockPath(dir, DEFAULT_CONFIG))).resolves.toBe(true);
      await expect(readActiveSession(dir, DEFAULT_CONFIG)).resolves.toMatchObject({ id: session.id });
      await expect(readSessionBaseline(session.sessionDir)).resolves.toMatchObject({
        git: { repoRoot: dir },
      });
    } finally {
      await removeTempDir(dir);
    }
  });

  it("preserves completed sessions when the system clock repeats a timestamp", async () => {
    const dir = await createTempDir();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    try {
      initGitRepo(dir);
      const first = await createSession(dir, DEFAULT_CONFIG);
      await appendFileEvent(first, { timestamp: first.startedAt, eventType: "change", path: "src/first.ts" });
      await finalizeSession(first, DEFAULT_CONFIG, "test");
      const eventsBefore = await readFile(getEventsPath(first.sessionDir), "utf8");

      const second = await createSession(dir, DEFAULT_CONFIG);
      expect(second.id).not.toBe(first.id);
      expect(second.sessionDir).not.toBe(first.sessionDir);
      expect(await readFile(getEventsPath(first.sessionDir), "utf8")).toBe(eventsBefore);
      expect(await pathExists(path.join(first.sessionDir, "session-metadata.json"))).toBe(true);
    } finally {
      vi.useRealTimers();
      await removeTempDir(dir);
    }
  });

  it("cleans stale ownership state only after verifying the completed report", async () => {
    const dir = await createTempDir();
    try {
      initGitRepo(dir);
      const session = await createSession(dir, DEFAULT_CONFIG);
      const lock = await readSessionLock(dir, DEFAULT_CONFIG);
      await finalizeSession(session, DEFAULT_CONFIG, "test");
      await writeFile(getActiveSessionPath(dir, DEFAULT_CONFIG), JSON.stringify({ ...session, pid: 999_999 }));
      await writeFile(getSessionLockPath(dir, DEFAULT_CONFIG), JSON.stringify({ ...lock, pid: 999_999 }));

      await expect(inspectSessionRecoveryState(dir, DEFAULT_CONFIG)).resolves.toMatchObject({
        status: "already-complete",
      });
      await expect(recoverActiveSession(dir, DEFAULT_CONFIG)).resolves.toEqual({ state: "already-complete" });
      expect(await pathExists(getActiveSessionPath(dir, DEFAULT_CONFIG))).toBe(false);
      expect(await pathExists(getSessionLockPath(dir, DEFAULT_CONFIG))).toBe(false);
      expect(await pathExists(path.join(session.sessionDir, "session.json"))).toBe(true);
    } finally {
      await removeTempDir(dir);
    }
  });

  it("rechecks RSS after completed-report inspection before cleaning ownership", async () => {
    const dir = await createTempDir();
    const limit = 64 * 1024 * 1024;
    const rss = vi.spyOn(process.memoryUsage, "rss").mockReturnValue(limit);
    try {
      initGitRepo(dir);
      const session = await createSession(dir, DEFAULT_CONFIG);
      const lock = await readSessionLock(dir, DEFAULT_CONFIG);
      await finalizeSession(session, DEFAULT_CONFIG, "test");
      await writeFile(getActiveSessionPath(dir, DEFAULT_CONFIG), JSON.stringify({ ...session, pid: 999_999 }));
      await writeFile(getSessionLockPath(dir, DEFAULT_CONFIG), JSON.stringify({ ...lock, pid: 999_999 }));
      const evidence = [
        getActiveSessionPath(dir, DEFAULT_CONFIG),
        getSessionLockPath(dir, DEFAULT_CONFIG),
        path.join(session.sessionDir, "session.json"),
      ];
      const before = await Promise.all(evidence.map((file) => readFile(file)));
      rss.mockReturnValue(limit + 1).mockReturnValueOnce(limit);
      await expect(recoverActiveSession(dir, DEFAULT_CONFIG, { maxRssBytes: limit })).rejects.toThrow("RSS");
      expect(await Promise.all(evidence.map((file) => readFile(file)))).toEqual(before);
      expect((await readdir(session.sessionDir)).filter((name) => name.startsWith("finalization-claim-"))).toEqual([]);
      rss.mockReturnValue(limit);
      await expect(recoverActiveSession(dir, DEFAULT_CONFIG, { maxRssBytes: limit })).resolves.toEqual({
        state: "already-complete",
      });
      expect(await pathExists(getActiveSessionPath(dir, DEFAULT_CONFIG))).toBe(false);
      expect(await pathExists(getSessionLockPath(dir, DEFAULT_CONFIG))).toBe(false);
    } finally {
      rss.mockRestore();
      await removeTempDir(dir);
    }
  });

  it("preserves ownership when stop-request cleanup fails so completed recovery can be retried", async () => {
    const dir = await createTempDir();
    try {
      initGitRepo(dir);
      const session = await createSession(dir, DEFAULT_CONFIG);
      const lock = await readSessionLock(dir, DEFAULT_CONFIG);
      await writeFile(getActiveSessionPath(dir, DEFAULT_CONFIG), JSON.stringify({ ...session, pid: 999_999 }));
      await writeFile(getSessionLockPath(dir, DEFAULT_CONFIG), JSON.stringify({ ...lock, pid: 999_999 }));
      const stopRequestPath = getStopRequestPath(dir, DEFAULT_CONFIG);
      await mkdir(stopRequestPath);

      await expect(recoverActiveSession(dir, DEFAULT_CONFIG)).rejects.toMatchObject({ code: "ERR_FS_EISDIR" });
      expect((await readActiveSession(dir, DEFAULT_CONFIG))?.id).toBe(session.id);
      expect((await readSessionLock(dir, DEFAULT_CONFIG))?.sessionId).toBe(session.id);
      await expect(inspectSessionRecoveryState(dir, DEFAULT_CONFIG)).resolves.toMatchObject({
        status: "already-complete",
      });
      const reportPath = path.join(session.sessionDir, "session.json");
      const completedReport = await readFile(reportPath, "utf8");
      await rm(stopRequestPath, { recursive: true });

      await expect(recoverActiveSession(dir, DEFAULT_CONFIG)).resolves.toEqual({ state: "already-complete" });
      expect(await pathExists(getActiveSessionPath(dir, DEFAULT_CONFIG))).toBe(false);
      expect(await pathExists(getSessionLockPath(dir, DEFAULT_CONFIG))).toBe(false);
      expect(await readFile(reportPath, "utf8")).toBe(completedReport);
    } finally {
      await removeTempDir(dir);
    }
  });

  it("appends and reads file events", async () => {
    const dir = await createTempDir();
    try {
      initGitRepo(dir);
      const session = await createSession(dir, DEFAULT_CONFIG);
      await appendFileEvent(session, {
        timestamp: "2026-01-01T00:00:00.000Z",
        eventType: "change",
        path: "src/index.ts",
      });

      await expect(readFileEvents(session.sessionDir)).resolves.toEqual([
        {
          timestamp: "2026-01-01T00:00:00.000Z",
          eventType: "change",
          path: "src/index.ts",
        },
      ]);
    } finally {
      await removeTempDir(dir);
    }
  });

  it("appends and reads command events", async () => {
    const dir = await createTempDir();
    try {
      initGitRepo(dir);
      const session = await createSession(dir, DEFAULT_CONFIG);
      await appendCommandEvent(session, {
        startedAt: "2026-01-01T00:00:00.000Z",
        endedAt: "2026-01-01T00:00:01.000Z",
        command: "pnpm test",
        cwd: ".",
        label: "tests",
        group: "validation",
        phase: "test",
        exitCode: 0,
        durationMs: 1000,
      });

      await expect(readCommandEvents(session.sessionDir)).resolves.toEqual([
        {
          startedAt: "2026-01-01T00:00:00.000Z",
          endedAt: "2026-01-01T00:00:01.000Z",
          command: "pnpm test",
          cwd: ".",
          label: "tests",
          group: "validation",
          phase: "test",
          exitCode: 0,
          durationMs: 1000,
        },
      ]);
    } finally {
      await removeTempDir(dir);
    }
  });

  it("validates finalization limits before mutating session state", async () => {
    const dir = await createTempDir();
    try {
      initGitRepo(dir);
      const session = await createSession(dir, DEFAULT_CONFIG);
      const evidencePaths = [getActiveSessionPath(dir, DEFAULT_CONFIG), getSessionLockPath(dir, DEFAULT_CONFIG)];
      const evidenceBefore = await Promise.all(evidencePaths.map((filePath) => readFile(filePath)));
      for (const maxRecordBytes of [0, -1, 1.5, MAX_REPORT_BYTES + 1, NaN, Infinity]) {
        await expect(finalizeSession(session, DEFAULT_CONFIG, "test", undefined, { maxRecordBytes })).rejects.toThrow(
          "maxRecordBytes"
        );
        await expect(recoverActiveSession(dir, DEFAULT_CONFIG, { maxRecordBytes })).rejects.toThrow("maxRecordBytes");
      }
      for (const commandWaitTimeoutMs of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity]) {
        await expect(
          finalizeSession(session, DEFAULT_CONFIG, "test", undefined, { commandWaitTimeoutMs })
        ).rejects.toThrow("commandWaitTimeoutMs");
        await expect(recoverActiveSession(dir, DEFAULT_CONFIG, { commandWaitTimeoutMs })).rejects.toThrow(
          "commandWaitTimeoutMs"
        );
      }
      for (const maxRecords of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity]) {
        await expect(finalizeSession(session, DEFAULT_CONFIG, "test", undefined, { maxRecords })).rejects.toThrow(
          "maxRecords"
        );
        await expect(recoverActiveSession(dir, DEFAULT_CONFIG, { maxRecords })).rejects.toThrow("maxRecords");
      }
      for (const maxRssBytes of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity]) {
        await expect(finalizeSession(session, DEFAULT_CONFIG, "test", undefined, { maxRssBytes })).rejects.toThrow(
          "maxRssBytes"
        );
        await expect(recoverActiveSession(dir, DEFAULT_CONFIG, { maxRssBytes })).rejects.toThrow("maxRssBytes");
      }
      expect(await Promise.all(evidencePaths.map((filePath) => readFile(filePath)))).toEqual(evidenceBefore);
      expect(await pathExists(path.join(session.sessionDir, "commands-closing"))).toBe(false);
      expect((await readdir(session.sessionDir)).filter((name) => name.startsWith("finalization-claim-"))).toEqual([]);
    } finally {
      await removeTempDir(dir);
    }
  });

  it("checks observed RSS while waiting for a live wrapper without removing its marker", async () => {
    const dir = await createTempDir();
    const limit = 64 * 1024 * 1024;
    let samples = 0;
    const rss = vi.spyOn(process.memoryUsage, "rss").mockImplementation(() => (++samples > 4 ? limit + 1 : limit));
    try {
      initGitRepo(dir);
      const session = await createSession(dir, DEFAULT_CONFIG);
      const marker = await registerInFlightCommand(session);
      const active = await readFile(getActiveSessionPath(dir, DEFAULT_CONFIG));
      await expect(
        finalizeSession(session, DEFAULT_CONFIG, "test", undefined, { maxRssBytes: limit, commandWaitTimeoutMs: 1000 })
      ).rejects.toThrow("RSS");
      expect(await pathExists(marker)).toBe(true);
      expect(await readFile(getActiveSessionPath(dir, DEFAULT_CONFIG))).toEqual(active);
      expect(await pathExists(path.join(session.sessionDir, "session.json"))).toBe(false);
    } finally {
      rss.mockRestore();
      await removeTempDir(dir);
    }
  });

  it("refuses observed RSS growth while reading logs, preserves evidence, and allows an exact-limit retry", async () => {
    const dir = await createTempDir();
    const limit = 64 * 1024 * 1024;
    const rss = vi.spyOn(process.memoryUsage, "rss").mockReturnValue(limit);
    const originalRead = ndjson.readNdjsonRecords;
    const reader = vi.spyOn(ndjson, "readNdjsonRecords");
    try {
      initGitRepo(dir);
      const session = await createSession(dir, DEFAULT_CONFIG);
      await appendFileEvent(session, { timestamp: session.startedAt, eventType: "change", path: "src/index.ts" });
      const evidencePaths = [
        getEventsPath(session.sessionDir),
        getCommandsPath(session.sessionDir),
        getActiveSessionPath(dir, DEFAULT_CONFIG),
        getSessionLockPath(dir, DEFAULT_CONFIG),
      ];
      const before = await Promise.all(evidencePaths.map((file) => readFile(file)));
      rss.mockReturnValue(limit + 1);
      await expect(finalizeSession(session, DEFAULT_CONFIG, "test", undefined, { maxRssBytes: limit })).rejects.toThrow(
        "RSS"
      );
      expect(await pathExists(path.join(session.sessionDir, "commands-closing"))).toBe(false);
      expect(await Promise.all(evidencePaths.map((file) => readFile(file)))).toEqual(before);
      rss.mockReturnValue(limit);
      reader.mockImplementation((file, guard, label, reserve, checkpoint) =>
        originalRead(
          file,
          (value): value is unknown => {
            rss.mockReturnValue(limit + 1);
            return guard(value);
          },
          label,
          reserve,
          checkpoint
        )
      );
      await expect(finalizeSession(session, DEFAULT_CONFIG, "test", undefined, { maxRssBytes: limit })).rejects.toThrow(
        "RSS"
      );
      expect(await Promise.all(evidencePaths.map((file) => readFile(file)))).toEqual(before);
      expect(await pathExists(path.join(session.sessionDir, "session.json"))).toBe(false);
      expect((await readdir(session.sessionDir)).filter((name) => name.startsWith("finalization-claim-"))).toEqual([]);
      reader.mockRestore();
      rss.mockReturnValue(limit);
      const report = await finalizeSession(session, DEFAULT_CONFIG, "test", undefined, { maxRssBytes: limit });
      expect(report.events).toHaveLength(1);
    } finally {
      reader.mockRestore();
      rss.mockRestore();
      await removeTempDir(dir);
    }
  });

  it("keeps finalization ownership until all input readers settle after a quota refusal", async () => {
    const dir = await createTempDir();
    const originalRead = ndjson.readNdjsonRecords;
    const reader = vi.spyOn(ndjson, "readNdjsonRecords");
    let releaseCommands: (() => void) | undefined;
    let finalizing: ReturnType<typeof finalizeSession> | undefined;
    try {
      initGitRepo(dir);
      const session = await createSession(dir, DEFAULT_CONFIG);
      await appendFileEvent(session, { timestamp: session.startedAt, eventType: "change", path: "src/index.ts" });
      let quotaRefused = false;
      reader.mockImplementation(async (filePath, guard, label, reserve) => {
        if (filePath === getCommandsPath(session.sessionDir)) {
          await new Promise<void>((resolve) => {
            releaseCommands = resolve;
          });
          return originalRead(filePath, guard, label, reserve);
        }
        return originalRead(filePath, guard, label, (bytes) => {
          try {
            reserve?.(bytes);
          } catch (error) {
            quotaRefused = true;
            throw error;
          }
        });
      });
      let settled = false;
      finalizing = finalizeSession(session, DEFAULT_CONFIG, "test", undefined, { maxRecordBytes: 1 }).finally(() => {
        settled = true;
      });
      const refusal = expect(finalizing).rejects.toThrow("canonical record allowance");
      await vi.waitFor(() => {
        expect(quotaRefused).toBe(true);
        expect(releaseCommands).toBeDefined();
      });
      expect(settled).toBe(false);
      expect((await readdir(session.sessionDir)).filter((name) => name.startsWith("finalization-claim-"))).toHaveLength(
        1
      );
      releaseCommands?.();
      await refusal;
      expect((await readdir(session.sessionDir)).filter((name) => name.startsWith("finalization-claim-"))).toEqual([]);
      expect((await readActiveSession(dir, DEFAULT_CONFIG))?.id).toBe(session.id);
    } finally {
      releaseCommands?.();
      await finalizing?.catch(() => undefined);
      reader.mockRestore();
      await removeTempDir(dir);
    }
  });

  it.each(["bytes", "records"])(
    "shares the %s allowance across both logs and preserves recovery after refusal",
    async (limit) => {
      const dir = await createTempDir();
      try {
        initGitRepo(dir);
        const session = await createSession(dir, DEFAULT_CONFIG);
        const event = {
          timestamp: "2026-01-01T00:00:00.000Z",
          eventType: "change" as const,
          path: "src/変更.ts",
          extra: "retained",
        };
        const command = {
          startedAt: event.timestamp,
          endedAt: event.timestamp,
          command: "node --version",
          cwd: ".",
          exitCode: 0,
          durationMs: 0,
          extra: { label: "保持" },
        };
        await writeFile(getEventsPath(session.sessionDir), `invalid\n${JSON.stringify(event)}\n`);
        await writeFile(getCommandsPath(session.sessionDir), `${JSON.stringify(command)}\n`);
        const evidencePaths = [
          getEventsPath(session.sessionDir),
          getCommandsPath(session.sessionDir),
          getActiveSessionPath(dir, DEFAULT_CONFIG),
          getSessionLockPath(dir, DEFAULT_CONFIG),
        ];
        const evidenceBefore = await Promise.all(evidencePaths.map((filePath) => readFile(filePath)));
        const combinedBytes = Buffer.byteLength(JSON.stringify(event)) + Buffer.byteLength(JSON.stringify(command));

        await expect(
          finalizeSession(
            session,
            DEFAULT_CONFIG,
            "test",
            undefined,
            limit === "bytes" ? { maxRecordBytes: combinedBytes - 1 } : { maxRecords: 1 }
          )
        ).rejects.toThrow(limit === "bytes" ? "canonical record allowance" : "record count allowance");
        expect(await Promise.all(evidencePaths.map((filePath) => readFile(filePath)))).toEqual(evidenceBefore);
        expect(await pathExists(path.join(session.sessionDir, "session.json"))).toBe(false);
        expect((await readdir(session.sessionDir)).filter((name) => name.startsWith("finalization-claim-"))).toEqual(
          []
        );
        const report = await finalizeSession(session, DEFAULT_CONFIG, "test", undefined, {
          maxRecordBytes: combinedBytes,
          maxRecords: 2,
        });
        expect(report.events).toEqual([event]);
        expect(report.commands).toEqual([command]);
        expect(report.integrity.discardedFileEventLines).toBe(1);
      } finally {
        await removeTempDir(dir);
      }
    }
  );

  it("bounds recovery waiting without discarding live command evidence and allows a complete retry", async () => {
    const dir = await createTempDir();
    let marker: string | undefined;
    let recovering: ReturnType<typeof recoverActiveSession> | undefined;
    try {
      initGitRepo(dir);
      const session = await createSession(dir, DEFAULT_CONFIG);
      marker = await registerInFlightCommand(session);
      const lock = await readSessionLock(dir, DEFAULT_CONFIG);
      await writeFile(getActiveSessionPath(dir, DEFAULT_CONFIG), JSON.stringify({ ...session, pid: 999_999 }));
      await writeFile(getSessionLockPath(dir, DEFAULT_CONFIG), JSON.stringify({ ...lock, pid: 999_999 }));
      const evidencePaths = [
        getEventsPath(session.sessionDir),
        getCommandsPath(session.sessionDir),
        getActiveSessionPath(dir, DEFAULT_CONFIG),
        getSessionLockPath(dir, DEFAULT_CONFIG),
      ];
      const evidenceBefore = await Promise.all(evidencePaths.map((filePath) => readFile(filePath)));
      recovering = recoverActiveSession(dir, DEFAULT_CONFIG, { commandWaitTimeoutMs: 1 });
      let deadline: ReturnType<typeof setTimeout> | undefined;
      const outcome = await Promise.race([
        recovering.then(
          () => ({ status: "resolved" }),
          (error: unknown) => ({ status: "rejected", error })
        ),
        new Promise<{ status: string }>((resolve) => {
          deadline = setTimeout(() => resolve({ status: "pending" }), 2000);
        }),
      ]).finally(() => clearTimeout(deadline));
      expect(outcome).toMatchObject({
        status: "rejected",
        error: expect.objectContaining({ message: expect.stringContaining("still running") }),
      });
      expect(await Promise.all(evidencePaths.map((filePath) => readFile(filePath)))).toEqual(evidenceBefore);
      expect(await pathExists(marker)).toBe(true);
      expect(await pathExists(path.join(session.sessionDir, "commands-closing"))).toBe(true);
      expect(await pathExists(path.join(session.sessionDir, "session.json"))).toBe(false);
      expect((await readdir(session.sessionDir)).filter((name) => name.startsWith("finalization-claim-"))).toEqual([]);
      await expect(registerInFlightCommand(session)).rejects.toThrow("closing");
      await appendCommandEvent(session, {
        startedAt: session.startedAt,
        endedAt: new Date().toISOString(),
        command: "node --version",
        cwd: ".",
        exitCode: 0,
        durationMs: 1,
      });
      await rm(marker);
      marker = undefined;
      const retried = await recoverActiveSession(dir, DEFAULT_CONFIG, { commandWaitTimeoutMs: 1 });
      expect(retried.report?.commands).toHaveLength(1);
      expect(await readActiveSession(dir, DEFAULT_CONFIG)).toBeNull();
      expect(await readSessionLock(dir, DEFAULT_CONFIG)).toBeNull();
    } finally {
      if (marker) await rm(marker, { force: true });
      await recovering?.catch(() => undefined);
      await removeTempDir(dir);
    }
  }, 15_000);

  it("waits for a registered command before reading the finalized report", async () => {
    const dir = await createTempDir();
    try {
      initGitRepo(dir);
      const session = await createSession(dir, DEFAULT_CONFIG);
      const marker = await registerInFlightCommand(session);
      const finalizing = finalizeSession(session, DEFAULT_CONFIG, "test");
      await vi.waitFor(async () => {
        expect(await pathExists(path.join(session.sessionDir, "commands-closing"))).toBe(true);
      });
      await expect(registerInFlightCommand(session)).rejects.toThrow("closing");

      await appendCommandEvent(session, {
        startedAt: "2026-01-01T00:00:00.000Z",
        endedAt: "2026-01-01T00:00:01.000Z",
        command: "pnpm test",
        cwd: ".",
        exitCode: 0,
        durationMs: 1000,
      });
      await rm(marker);

      const report = await finalizing;
      expect(report.commands).toHaveLength(1);
      expect(report.integrity.warnings).toEqual([]);
    } finally {
      await removeTempDir(dir);
    }
  }, 15_000);

  it("reports an interrupted wrapped command during finalization", async () => {
    const dir = await createTempDir();
    try {
      initGitRepo(dir);
      const session = await createSession(dir, DEFAULT_CONFIG);
      await writeFile(
        path.join(session.sessionDir, "command-inflight-999999-00000000-0000-4000-8000-000000000000"),
        ""
      );

      const report = await finalizeSession(session, DEFAULT_CONFIG, "recovery");
      expect(report.integrity.warnings).toContain(
        "1 wrapped command(s) ended before their completion could be recorded."
      );
    } finally {
      await removeTempDir(dir);
    }
  });

  it("preserves capture-loss warnings when a watcher exits before normal finalization", async () => {
    const dir = await createTempDir();
    try {
      initGitRepo(dir);
      const session = await createSession(dir, DEFAULT_CONFIG);
      await Promise.all([
        markCaptureLoss(session, "overflow"),
        markCaptureLoss(session, "writeFailure"),
        markCaptureLoss(session, "watcherError"),
      ]);

      const report = await finalizeSession(session, DEFAULT_CONFIG, "recovery");
      expect(report.integrity.warnings).toEqual(
        expect.arrayContaining([
          expect.stringContaining("number of dropped file events is unknown"),
          expect.stringContaining("number of lost events is unknown"),
          expect.stringContaining("watcher reported an error"),
        ])
      );
    } finally {
      await removeTempDir(dir);
    }
  });

  it("recovers readable records when event data contains malformed lines", async () => {
    const dir = await createTempDir();
    try {
      initGitRepo(dir);
      const session = await createSession(dir, DEFAULT_CONFIG);
      await writeFile(
        getEventsPath(session.sessionDir),
        [
          JSON.stringify({
            timestamp: "2026-01-01T00:00:00.000Z",
            eventType: "change",
            path: "src/index.ts",
          }),
          "{not-json}",
          JSON.stringify({ timestamp: "2026-01-01T00:00:01.000Z", eventType: "bad", path: "x" }),
        ].join("\n"),
        "utf8"
      );

      const result = await readFileEventsWithDiagnostics(session.sessionDir);

      expect(result.records).toHaveLength(1);
      expect(result.discardedLines).toBe(2);
      expect(result.warnings).toHaveLength(2);
    } finally {
      await removeTempDir(dir);
    }
  });

  it("discards oversized NDJSON lines without losing later records", async () => {
    const dir = await createTempDir();
    try {
      initGitRepo(dir);
      const session = await createSession(dir, DEFAULT_CONFIG);
      const validEvent = JSON.stringify({
        timestamp: "2026-01-01T00:00:00.000Z",
        eventType: "change",
        path: "src/index.ts",
      });
      await writeFile(getEventsPath(session.sessionDir), `${"x".repeat(1024 * 1024 + 1)}\n${validEvent}\n`, "utf8");

      const result = await readFileEventsWithDiagnostics(session.sessionDir);

      expect(result.records).toHaveLength(1);
      expect(result.discardedLines).toBe(1);
      expect(result.warnings[0]).toContain("oversized");
    } finally {
      await removeTempDir(dir);
    }
  });

  it("reports corrupted active session state without throwing", async () => {
    const dir = await createTempDir();
    try {
      await mkdir(path.dirname(getActiveSessionPath(dir, DEFAULT_CONFIG)), { recursive: true });
      await writeFile(getActiveSessionPath(dir, DEFAULT_CONFIG), "{not-json}", "utf8");

      const state = await readActiveSessionState(dir, DEFAULT_CONFIG);

      expect(state.value).toBeNull();
      expect(state.corrupted).toBe(true);
    } finally {
      await removeTempDir(dir);
    }
  });

  it("recovers a stale session only when its lock ownership matches", async () => {
    const dir = await createTempDir();
    try {
      initGitRepo(dir);
      const session = await createSession(dir, DEFAULT_CONFIG);
      const stale = { ...session, pid: 999_999 };
      const lock = await readSessionLock(dir, DEFAULT_CONFIG);
      expect(lock).not.toBeNull();

      await writeFile(getActiveSessionPath(dir, DEFAULT_CONFIG), `${JSON.stringify(stale)}\n`, "utf8");
      await writeFile(
        getSessionLockPath(dir, DEFAULT_CONFIG),
        `${JSON.stringify({ ...lock, pid: stale.pid })}\n`,
        "utf8"
      );

      await expect(inspectSessionRecoveryState(dir, DEFAULT_CONFIG)).resolves.toMatchObject({ status: "recoverable" });
      const recovered = await recoverActiveSession(dir, DEFAULT_CONFIG);

      expect(recovered.report).toMatchObject({ id: session.id, finalizedBy: "recovery" });
      await expect(readActiveSession(dir, DEFAULT_CONFIG)).resolves.toBeNull();
      await expect(pathExists(getSessionLockPath(dir, DEFAULT_CONFIG))).resolves.toBe(false);
    } finally {
      await removeTempDir(dir);
    }
  });

  it("refuses recovery when the lock owner token does not match", async () => {
    const dir = await createTempDir();
    try {
      initGitRepo(dir);
      const session = await createSession(dir, DEFAULT_CONFIG);
      const stale = { ...session, pid: 999_999 };
      const lock = await readSessionLock(dir, DEFAULT_CONFIG);
      expect(lock).not.toBeNull();

      await writeFile(getActiveSessionPath(dir, DEFAULT_CONFIG), `${JSON.stringify(stale)}\n`, "utf8");
      await writeFile(
        getSessionLockPath(dir, DEFAULT_CONFIG),
        `${JSON.stringify({ ...lock, pid: stale.pid, ownerToken: "00000000-0000-4000-8000-000000000000" })}\n`,
        "utf8"
      );

      await expect(inspectSessionRecoveryState(dir, DEFAULT_CONFIG)).resolves.toMatchObject({ status: "inconsistent" });
      await expect(recoverActiveSession(dir, DEFAULT_CONFIG)).rejects.toThrow("do not have the same owner");
      await expect(readActiveSession(dir, DEFAULT_CONFIG)).resolves.toMatchObject({ id: session.id });
      await expect(pathExists(getSessionLockPath(dir, DEFAULT_CONFIG))).resolves.toBe(true);
    } finally {
      await removeTempDir(dir);
    }
  });

  it.each(["missing", "corrupt"])("retains stale state when completion metadata has a %s report", async (kind) => {
    const dir = await createTempDir();
    try {
      initGitRepo(dir);
      const session = await createSession(dir, DEFAULT_CONFIG);
      const lock = await readSessionLock(dir, DEFAULT_CONFIG);
      await writeFile(getActiveSessionPath(dir, DEFAULT_CONFIG), JSON.stringify({ ...session, pid: 999_999 }));
      await writeFile(getSessionLockPath(dir, DEFAULT_CONFIG), JSON.stringify({ ...lock, pid: 999_999 }));
      await writeFile(path.join(session.sessionDir, "session-metadata.json"), JSON.stringify({ id: session.id }));
      if (kind === "corrupt") {
        await writeFile(path.join(session.sessionDir, "session.json"), "{not-json}");
      }

      await expect(inspectSessionRecoveryState(dir, DEFAULT_CONFIG)).resolves.toMatchObject({ status: "corrupt" });
      await expect(recoverActiveSession(dir, DEFAULT_CONFIG)).rejects.toThrow("completed report");
      expect(await pathExists(getActiveSessionPath(dir, DEFAULT_CONFIG))).toBe(true);
      expect(await pathExists(getSessionLockPath(dir, DEFAULT_CONFIG))).toBe(true);
    } finally {
      await removeTempDir(dir);
    }
  });

  it("refuses recovery when a stale session lock is missing", async () => {
    const dir = await createTempDir();
    try {
      initGitRepo(dir);
      const session = await createSession(dir, DEFAULT_CONFIG);
      await writeFile(
        getActiveSessionPath(dir, DEFAULT_CONFIG),
        `${JSON.stringify({ ...session, pid: 999_999 })}\n`,
        "utf8"
      );
      await rm(getSessionLockPath(dir, DEFAULT_CONFIG));

      await expect(inspectSessionRecoveryState(dir, DEFAULT_CONFIG)).resolves.toMatchObject({ status: "inconsistent" });
      await expect(recoverActiveSession(dir, DEFAULT_CONFIG)).rejects.toThrow("no lock ownership proof");
      await expect(readActiveSession(dir, DEFAULT_CONFIG)).resolves.toMatchObject({ id: session.id });
    } finally {
      await removeTempDir(dir);
    }
  });

  it("refuses publication and preserves unrelated claims after storage moves during log reads", async () => {
    const dir = await createTempDir();
    const outside = await createTempDir();
    const originalRead = ndjson.readNdjsonRecords;
    const reader = vi.spyOn(ndjson, "readNdjsonRecords");
    let releaseRecords: (() => void) | undefined;
    let finalizing: ReturnType<typeof finalizeSession> | undefined;
    try {
      initGitRepo(dir);
      const session = await createSession(dir, DEFAULT_CONFIG);
      await appendFileEvent(session, { timestamp: session.startedAt, eventType: "change", path: "src/index.ts" });
      const ownershipPaths = [getActiveSessionPath(dir, DEFAULT_CONFIG), getSessionLockPath(dir, DEFAULT_CONFIG)];
      const ownershipBefore = await Promise.all(ownershipPaths.map((filePath) => readFile(filePath)));
      reader.mockImplementation(async (filePath, guard, label, reserve) => {
        const result = await originalRead(filePath, guard, label, reserve);
        if (filePath === getEventsPath(session.sessionDir)) {
          await new Promise<void>((resolve) => {
            releaseRecords = resolve;
          });
        }
        return result;
      });
      finalizing = finalizeSession(session, DEFAULT_CONFIG, "test");
      const refusal = expect(finalizing).rejects.toThrow("storage location");
      await vi.waitFor(() => expect(releaseRecords).toBeDefined());
      const evidenceNames = (await readdir(session.sessionDir)).sort();
      const evidenceBefore = await Promise.all(
        evidenceNames.map((name) => readFile(path.join(session.sessionDir, name)))
      );
      const claimNames = evidenceNames.filter((name) => name.startsWith("finalization-claim-"));
      expect(claimNames).toHaveLength(1);
      const target = path.join(outside, "unrelated");
      await mkdir(target);
      const unrelatedClaim = path.join(target, claimNames[0]!);
      await writeFile(unrelatedClaim, "preserve unrelated claim");
      const moved = path.join(outside, "moved-evidence");
      await rename(session.sessionDir, moved);
      await symlink(target, session.sessionDir, process.platform === "win32" ? "junction" : "dir");
      releaseRecords?.();
      await refusal;

      expect((await readdir(target)).sort()).toEqual(claimNames);
      expect(await readFile(unrelatedClaim, "utf8")).toBe("preserve unrelated claim");
      expect(await pathExists(path.join(target, "rollback-state.json"))).toBe(false);
      expect(await pathExists(path.join(target, "session.json"))).toBe(false);
      expect((await readdir(moved)).sort()).toEqual(evidenceNames);
      expect(await Promise.all(evidenceNames.map((name) => readFile(path.join(moved, name))))).toEqual(evidenceBefore);
      expect(await Promise.all(ownershipPaths.map((filePath) => readFile(filePath)))).toEqual(ownershipBefore);
    } finally {
      releaseRecords?.();
      await finalizing?.catch(() => undefined);
      reader.mockRestore();
      await removeTempDir(dir);
      await removeTempDir(outside);
    }
  });

  it.each(["recovery", "finalization"])(
    "refuses %s through a displaced session directory without mutating its target",
    async (operation) => {
      const dir = await createTempDir();
      const outside = await createTempDir();
      try {
        initGitRepo(dir);
        const session = await createSession(dir, DEFAULT_CONFIG);
        if (operation === "recovery") {
          const lock = await readSessionLock(dir, DEFAULT_CONFIG);
          await writeFile(getActiveSessionPath(dir, DEFAULT_CONFIG), JSON.stringify({ ...session, pid: 999_999 }));
          await writeFile(getSessionLockPath(dir, DEFAULT_CONFIG), JSON.stringify({ ...lock, pid: 999_999 }));
        }
        const activeBytes = await readFile(getActiveSessionPath(dir, DEFAULT_CONFIG), "utf8");
        const lockBytes = await readFile(getSessionLockPath(dir, DEFAULT_CONFIG), "utf8");
        const target = path.join(outside, "evidence");
        await rename(session.sessionDir, target);
        await symlink(target, session.sessionDir, process.platform === "win32" ? "junction" : "dir");
        const names = (await readdir(target)).sort();
        const contents = await Promise.all(names.map((name) => readFile(path.join(target, name))));

        if (operation === "recovery") {
          await expect(inspectSessionRecoveryState(dir, DEFAULT_CONFIG)).resolves.toMatchObject({
            status: "inconsistent",
          });
          await expect(recoverActiveSession(dir, DEFAULT_CONFIG)).rejects.toThrow("does not belong to this repository");
        } else {
          await expect(finalizeSession(session, DEFAULT_CONFIG, "test")).rejects.toThrow("storage location");
        }
        expect((await readdir(target)).sort()).toEqual(names);
        expect(await Promise.all(names.map((name) => readFile(path.join(target, name))))).toEqual(contents);
        expect(await readFile(getActiveSessionPath(dir, DEFAULT_CONFIG), "utf8")).toBe(activeBytes);
        expect(await readFile(getSessionLockPath(dir, DEFAULT_CONFIG), "utf8")).toBe(lockBytes);
      } finally {
        await removeTempDir(dir);
        await removeTempDir(outside);
      }
    }
  );

  it.each([false, true])("finalizes explicitly configured external storage (aliases=%s)", async (aliases) => {
    const dir = await createTempDir();
    const outside = await createTempDir();
    try {
      initGitRepo(dir);
      const storage = path.join(outside, "sessions");
      await mkdir(storage);
      const repoRoot = aliases ? path.join(outside, "repository-alias") : dir;
      const sessionRoot = aliases ? path.join(outside, "storage-alias") : storage;
      if (aliases) {
        await symlink(dir, repoRoot, process.platform === "win32" ? "junction" : "dir");
        await symlink(storage, sessionRoot, process.platform === "win32" ? "junction" : "dir");
      }
      const config = { ...DEFAULT_CONFIG, sessionDir: sessionRoot };
      const session = await createSession(repoRoot, config);
      await expect(finalizeSession(session, config, "test")).resolves.toMatchObject({ id: session.id });
      expect(await pathExists(path.join(session.sessionDir, "session.json"))).toBe(true);
      expect(await readActiveSession(repoRoot, config)).toBeNull();
      expect(await readSessionLock(repoRoot, config)).toBeNull();
    } finally {
      await removeTempDir(dir);
      await removeTempDir(outside);
    }
  });

  it("refuses recovery when active state resolves outside the expected session directory", async () => {
    const dir = await createTempDir();
    try {
      initGitRepo(dir);
      const session = await createSession(dir, DEFAULT_CONFIG);
      const unexpectedSessionDir = path.join(dir, "unexpected-session");
      await mkdir(unexpectedSessionDir);
      await writeFile(
        getActiveSessionPath(dir, DEFAULT_CONFIG),
        `${JSON.stringify({ ...session, sessionDir: unexpectedSessionDir, pid: 999_999 })}\n`,
        "utf8"
      );

      await expect(inspectSessionRecoveryState(dir, DEFAULT_CONFIG)).resolves.toMatchObject({ status: "inconsistent" });
      await expect(recoverActiveSession(dir, DEFAULT_CONFIG)).rejects.toThrow("does not belong to this repository");
    } finally {
      await removeTempDir(dir);
    }
  });

  it("ignores malformed stop requests", async () => {
    const dir = await createTempDir();
    try {
      await mkdir(path.dirname(getStopRequestPath(dir, DEFAULT_CONFIG)), { recursive: true });
      await writeFile(getStopRequestPath(dir, DEFAULT_CONFIG), "{not-json}", "utf8");

      await expect(readStopRequest(dir, DEFAULT_CONFIG)).resolves.toBeNull();
    } finally {
      await removeTempDir(dir);
    }
  });
});
