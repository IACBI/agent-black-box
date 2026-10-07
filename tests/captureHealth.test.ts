import { lstat, mkdir, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActiveSession } from "../src/types.js";
import {
  inspectSessionCaptureHealth,
  MAX_CAPTURE_HEALTH_ENTRIES,
  renderSessionCaptureHealth,
} from "../src/session/captureHealth.js";
import * as sessionManager from "../src/session/sessionManager.js";
import { createTempDir, removeTempDir } from "./testUtils.js";

const fsMocks = vi.hoisted(() => ({ lstat: vi.fn(), opendir: vi.fn() }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...original,
    lstat: fsMocks.lstat.mockImplementation(original.lstat),
    opendir: fsMocks.opendir.mockImplementation(original.opendir),
  };
});

const temporaryDirectories: string[] = [];
const token = "00000000-0000-4000-8000-000000000000";

beforeEach(async () => {
  const original = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  fsMocks.lstat.mockReset().mockImplementation(original.lstat);
  fsMocks.opendir.mockReset().mockImplementation(original.opendir);
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const directory of temporaryDirectories.splice(0)) {
    await removeTempDir(directory);
  }
});

async function createFixture(): Promise<ActiveSession> {
  const directory = await createTempDir("abb-capture-health-");
  temporaryDirectories.push(directory);
  return {
    id: "session-capture-health",
    repoRoot: directory,
    sessionDir: directory,
    pid: process.pid,
    startedAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("session capture health", () => {
  it("inspects persisted health without reading or modifying raw event data", async () => {
    const session = await createFixture();
    const logPath = path.join(session.sessionDir, "events.ndjson");
    const rawLog = "synthetic sensitive event contents\n{not-json}\n";
    await writeFile(logPath, rawLog);
    await writeFile(path.join(session.sessionDir, "__proto__"), "");
    const names = await readdir(session.sessionDir);
    const before = await lstat(logPath);

    const health = await inspectSessionCaptureHealth(session);

    expect(health.status).toBe("healthy");
    expect(health.inspectionComplete).toBe(true);
    expect(health.scope).toBe("persisted-markers");
    expect(health.closing).toBe(false);
    expect(health.note).toContain("pending writes");
    expect(health.note).toContain("not observable");
    expect(health.inspectedEntries).toBe(2);
    expect(health.counters).toEqual({
      watcherOverflow: 0,
      watcherWriteFailures: 0,
      watcherErrors: 0,
      failedCommands: 0,
      interruptedCommands: 0,
      liveCommands: 0,
    });
    expect(await readFile(logPath, "utf8")).toBe(rawLog);
    expect(await readdir(session.sessionDir)).toEqual(names);
    expect((await lstat(logPath)).mtimeMs).toBe(before.mtimeMs);
    expect(JSON.stringify(health)).not.toContain("sensitive event contents");
  });

  it.each([
    ["capture-loss-overflow", "watcherOverflow", "queue overflow"],
    ["capture-loss-write-failure", "watcherWriteFailures", "write failures"],
    ["capture-loss-watcher-error", "watcherErrors", "watcher error"],
  ] as const)("reports persisted %s capture loss", async (name, counter, reason) => {
    const session = await createFixture();
    await writeFile(path.join(session.sessionDir, name), "");
    const health = await inspectSessionCaptureHealth(session);
    expect(health.status).toBe("degraded");
    expect(health.counters[counter]).toBe(1);
    expect(health.reasons.join(" ")).toContain(reason);
    expect(health.note).toContain("Only persisted markers");
  });

  it("distinguishes live, interrupted, failed, and completed command markers while closing", async () => {
    const session = await createFixture();
    vi.spyOn(sessionManager, "isProcessRunning").mockImplementation((pid) => pid === 1234);
    for (const name of [
      `command-inflight-1234-${token}`,
      `command-inflight-5678-${token}`,
      `command-failed-1234-${token}`,
      `command-completed-1234-${token}`,
      "commands-closing",
    ]) {
      await writeFile(path.join(session.sessionDir, name), "");
    }
    const health = await inspectSessionCaptureHealth(session);
    expect(health.status).toBe("degraded");
    expect(health.counters).toMatchObject({ liveCommands: 1, interruptedCommands: 1, failedCommands: 1 });
    expect(health.closing).toBe(true);
    expect(health.reasons.join(" ")).toContain("could not be persisted");
    expect(health.reasons.join(" ")).toContain("no longer have a live wrapper");
    expect(renderSessionCaptureHealth(health)).toContain("Live wrapped commands: 1; failed: 1; interrupted: 1");
  });

  it("does not treat a live wrapped command as capture loss", async () => {
    const session = await createFixture();
    await writeFile(path.join(session.sessionDir, `command-inflight-${process.pid}-${token}`), "");
    const health = await inspectSessionCaptureHealth(session);
    expect(health.status).toBe("healthy");
    expect(health.counters.liveCommands).toBe(1);
    expect(health.note).toContain("unrecorded losses are not observable");
  });

  it.each(["failed", "inflight"])("reports an isolated %s command marker as degraded", async (kind) => {
    const session = await createFixture();
    vi.spyOn(sessionManager, "isProcessRunning").mockReturnValue(false);
    await writeFile(path.join(session.sessionDir, `command-${kind}-999999-${token}`), "");
    const health = await inspectSessionCaptureHealth(session);
    expect(health.status).toBe("degraded");
    expect(health.counters[kind === "failed" ? "failedCommands" : "interruptedCommands"]).toBe(1);
    expect(health.inspectionComplete).toBe(true);
  });

  it.each([
    ["command-inflight-bad-pid", ""],
    [`command-inflight-0-${token}`, ""],
    [`command-inflight-999999999999999999-${token}`, ""],
    ["capture-loss-overflow", "unexpected marker contents"],
    ["capture-loss-unrecognized", ""],
  ])("reports corrupt marker %s conservatively", async (name, contents) => {
    const session = await createFixture();
    await writeFile(path.join(session.sessionDir, name), contents);
    const health = await inspectSessionCaptureHealth(session);
    expect(health.status).toBe("unknown");
    expect(health.closing).toBeNull();
    expect(health.reasons.length).toBeGreaterThan(0);
  });

  it("rejects linked marker metadata and leaves the target untouched", async () => {
    const session = await createFixture();
    const target = path.join(session.sessionDir, "target");
    await writeFile(target, "synthetic secret target contents");
    await symlink(target, path.join(session.sessionDir, "capture-loss-overflow"), "file");
    const health = await inspectSessionCaptureHealth(session);
    expect(health.status).toBe("unknown");
    expect(health.counters.watcherOverflow).toBe(0);
    expect(await readFile(target, "utf8")).toBe("synthetic secret target contents");
    expect(JSON.stringify(health)).not.toContain("secret target contents");
  });

  it("rejects a linked session directory before opening it", async () => {
    const session = await createFixture();
    const target = path.join(session.sessionDir, "target");
    const linked = path.join(session.sessionDir, "linked");
    await mkdir(target);
    await writeFile(path.join(target, "capture-loss-overflow"), "");
    await symlink(target, linked, process.platform === "win32" ? "junction" : "dir");
    const health = await inspectSessionCaptureHealth({ ...session, sessionDir: linked });
    expect(health.status).toBe("unknown");
    expect(health.inspectedEntries).toBe(0);
    expect(fsMocks.opendir).not.toHaveBeenCalled();
  });

  it("reports unreadable markers without exposing filesystem error messages", async () => {
    const session = await createFixture();
    await writeFile(path.join(session.sessionDir, "capture-loss-overflow"), "");
    fsMocks.lstat.mockResolvedValueOnce(await lstat(session.sessionDir));
    fsMocks.lstat.mockRejectedValueOnce(Object.assign(new Error("synthetic confidential path"), { code: "EACCES" }));
    const health = await inspectSessionCaptureHealth(session);
    expect(health.status).toBe("unknown");
    expect(health.reasons.join(" ")).toContain("EACCES");
    expect(JSON.stringify(health)).not.toContain("confidential path");
  });

  it("returns unknown when a directory cannot be read", async () => {
    const session = await createFixture();
    fsMocks.opendir.mockRejectedValueOnce(Object.assign(new Error("synthetic confidential path"), { code: "EACCES" }));
    const health = await inspectSessionCaptureHealth(session);
    expect(health.status).toBe("unknown");
    expect(health.closing).toBeNull();
    expect(health.reasons.join(" ")).toContain("EACCES");
    expect(JSON.stringify(health)).not.toContain("confidential path");
  });

  it("bounds streamed directory inspection and closes an interrupted iterator", async () => {
    const session = await createFixture();
    let closed = false;
    fsMocks.opendir.mockResolvedValueOnce({
      async *[Symbol.asyncIterator]() {
        try {
          for (let index = 0; index <= MAX_CAPTURE_HEALTH_ENTRIES; index += 1) {
            yield { name: `unrelated-${index}` };
          }
        } finally {
          closed = true;
        }
      },
    });
    const health = await inspectSessionCaptureHealth(session);
    expect(health.status).toBe("unknown");
    expect(health.truncated).toBe(true);
    expect(health.inspectionComplete).toBe(false);
    expect(health.inspectedEntries).toBe(MAX_CAPTURE_HEALTH_ENTRIES);
    expect(health.closing).toBeNull();
    expect(closed).toBe(true);
  });

  it("keeps confirmed failure evidence degraded even if later inspection is incomplete", async () => {
    const session = await createFixture();
    await writeFile(path.join(session.sessionDir, "capture-loss-overflow"), "");
    fsMocks.opendir.mockResolvedValueOnce({
      async *[Symbol.asyncIterator]() {
        yield { name: "capture-loss-overflow" };
        throw Object.assign(new Error("synthetic secret"), { code: "EIO" });
      },
    });
    const health = await inspectSessionCaptureHealth(session);
    expect(health.status).toBe("degraded");
    expect(health.counters.watcherOverflow).toBe(1);
    expect(health.reasons.join(" ")).toContain("EIO");
    expect(health.closing).toBeNull();
    expect(health.inspectionComplete).toBe(false);
  });
});
