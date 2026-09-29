import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG } from "../src/config/defaults.js";
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
