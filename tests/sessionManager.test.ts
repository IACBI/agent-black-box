import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/config/defaults.js";
import {
  createSession,
  getActiveSessionPath,
  getCommandsPath,
  getEventsPath,
  getSessionLockPath,
  readCommandEvents,
  readActiveSession,
  readActiveSessionState,
  readFileEvents,
  readFileEventsWithDiagnostics,
  appendCommandEvent,
  appendFileEvent
} from "../src/session/sessionManager.js";
import { pathExists } from "../src/utils/files.js";
import { createTempDir, removeTempDir } from "./testUtils.js";

describe("session manager", () => {
  it("creates a session and active session state", async () => {
    const dir = await createTempDir();
    try {
      const session = await createSession(dir, DEFAULT_CONFIG);

      await expect(pathExists(session.sessionDir)).resolves.toBe(true);
      await expect(pathExists(getEventsPath(session.sessionDir))).resolves.toBe(true);
      await expect(pathExists(getCommandsPath(session.sessionDir))).resolves.toBe(true);
      await expect(pathExists(getActiveSessionPath(dir, DEFAULT_CONFIG))).resolves.toBe(true);
      await expect(pathExists(getSessionLockPath(dir, DEFAULT_CONFIG))).resolves.toBe(true);
      await expect(readActiveSession(dir, DEFAULT_CONFIG)).resolves.toMatchObject({ id: session.id });
    } finally {
      await removeTempDir(dir);
    }
  });

  it("appends and reads file events", async () => {
    const dir = await createTempDir();
    try {
      const session = await createSession(dir, DEFAULT_CONFIG);
      await appendFileEvent(session, {
        timestamp: "2026-01-01T00:00:00.000Z",
        eventType: "change",
        path: "src/index.ts"
      });

      await expect(readFileEvents(session.sessionDir)).resolves.toEqual([
        {
          timestamp: "2026-01-01T00:00:00.000Z",
          eventType: "change",
          path: "src/index.ts"
        }
      ]);
    } finally {
      await removeTempDir(dir);
    }
  });

  it("appends and reads command events", async () => {
    const dir = await createTempDir();
    try {
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
        durationMs: 1000
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
          durationMs: 1000
        }
      ]);
    } finally {
      await removeTempDir(dir);
    }
  });

  it("recovers readable records when event data contains malformed lines", async () => {
    const dir = await createTempDir();
    try {
      const session = await createSession(dir, DEFAULT_CONFIG);
      await writeFile(
        getEventsPath(session.sessionDir),
        [
          JSON.stringify({
            timestamp: "2026-01-01T00:00:00.000Z",
            eventType: "change",
            path: "src/index.ts"
          }),
          "{not-json}",
          JSON.stringify({ timestamp: "2026-01-01T00:00:01.000Z", eventType: "bad", path: "x" })
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
});
