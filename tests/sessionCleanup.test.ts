import * as fs from "node:fs/promises";
import * as fileUtils from "../src/utils/files.js";
import { mkdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG } from "../src/config/defaults.js";
import {
  createSession,
  finalizeSession,
  getActiveSessionPath,
  getSessionLockPath,
  inspectSessionRecoveryState,
  readActiveSession,
  readSessionLock,
  recoverActiveSession,
  writeStopRequest,
} from "../src/session/sessionManager.js";
import { pathExists } from "../src/utils/files.js";
import { createTempDir, initGitRepo, removeTempDir } from "./testUtils.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, rm: vi.fn(actual.rm), link: vi.fn(actual.link) };
});
vi.mock("../src/utils/files.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/utils/files.js")>();
  return {
    ...actual,
    syncDirectory: vi.fn(actual.syncDirectory),
    syncRegularFile: vi.fn(actual.syncRegularFile),
    writeJsonFile: vi.fn(actual.writeJsonFile),
  };
});

async function completedCleanupFixture(dir: string) {
  initGitRepo(dir);
  const session = await createSession(dir, DEFAULT_CONFIG);
  const lock = await readSessionLock(dir, DEFAULT_CONFIG);
  await finalizeSession(session, DEFAULT_CONFIG, "test");
  const stale = { ...session, pid: 999_999 };
  await writeFile(getSessionLockPath(dir, DEFAULT_CONFIG), JSON.stringify({ ...lock, pid: stale.pid }));
  const receiptPath = path.join(session.sessionDir, "session-cleanup.json");
  await writeFile(receiptPath, JSON.stringify({ cleanupVersion: 1, active: stale }));
  return { session: stale, receiptPath };
}

describe("completed session cleanup recovery", () => {
  it("keeps the matching lock recoverable when active-state publication succeeds before start fails", async () => {
    const dir = await createTempDir();
    const actual = await vi.importActual<typeof import("../src/utils/files.js")>("../src/utils/files.js");
    try {
      initGitRepo(dir);
      const activePath = getActiveSessionPath(dir, DEFAULT_CONFIG);
      const failure = Object.assign(new Error("Post-publication directory flush failed."), { code: "EIO" });
      vi.mocked(fileUtils.writeJsonFile).mockImplementation(async (filePath, value) => {
        await actual.writeJsonFile(filePath, value);
        if (filePath === activePath) throw failure;
      });
      await expect(createSession(dir, DEFAULT_CONFIG)).rejects.toBe(failure);
      const active = await readActiveSession(dir, DEFAULT_CONFIG);
      if (!active) throw new Error("Expected published ownership after the failed start.");
      const lock = await readSessionLock(dir, DEFAULT_CONFIG);
      expect(lock).toMatchObject({ sessionId: active.id, ownerToken: active.ownerToken });
      expect(await pathExists(path.join(active.sessionDir, "session-metadata.json"))).toBe(false);
      vi.mocked(fileUtils.writeJsonFile).mockImplementation(actual.writeJsonFile);
      await writeFile(activePath, JSON.stringify({ ...active, pid: 999_999 }));
      await writeFile(getSessionLockPath(dir, DEFAULT_CONFIG), JSON.stringify({ ...lock, pid: 999_999 }));
      await expect(recoverActiveSession(dir, DEFAULT_CONFIG)).resolves.toMatchObject({
        state: "recoverable",
        report: { id: active.id },
      });
      expect(await pathExists(getSessionLockPath(dir, DEFAULT_CONFIG))).toBe(false);
    } finally {
      vi.mocked(fileUtils.writeJsonFile).mockImplementation(actual.writeJsonFile);
      await removeTempDir(dir);
    }
  });

  it("preserves both startup and lock-release failures", async () => {
    const dir = await createTempDir();
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    try {
      initGitRepo(dir);
      const startFailure = new Error("Startup metadata write failed.");
      const cleanupFailure = Object.assign(new Error("Lock release failed."), { code: "EACCES" });
      vi.mocked(fileUtils.writeJsonFile).mockRejectedValueOnce(startFailure);
      const lockPath = getSessionLockPath(dir, DEFAULT_CONFIG);
      vi.mocked(fs.rm).mockImplementation(async (filePath, options) => {
        if (filePath === lockPath) throw cleanupFailure;
        await actual.rm(filePath, options);
      });
      const failure: unknown = await createSession(dir, DEFAULT_CONFIG).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(AggregateError);
      expect((failure as AggregateError).errors).toEqual([startFailure, cleanupFailure]);
      expect((failure as AggregateError).cause).toBe(cleanupFailure);
      expect(await pathExists(getActiveSessionPath(dir, DEFAULT_CONFIG))).toBe(false);
      expect(await pathExists(lockPath)).toBe(true);
    } finally {
      vi.mocked(fs.rm).mockImplementation(actual.rm);
      await removeTempDir(dir);
    }
  });

  it.each(["receipt", "active-removal"])(
    "retains recoverable proof after the %s durability barrier fails",
    async (stage) => {
      const dir = await createTempDir();
      const actual = await vi.importActual<typeof import("../src/utils/files.js")>("../src/utils/files.js");
      try {
        initGitRepo(dir);
        const session = await createSession(dir, DEFAULT_CONFIG);
        const lock = await readSessionLock(dir, DEFAULT_CONFIG);
        const activePath = getActiveSessionPath(dir, DEFAULT_CONFIG);
        const lockPath = getSessionLockPath(dir, DEFAULT_CONFIG);
        await writeFile(activePath, JSON.stringify({ ...session, pid: 999_999 }));
        await writeFile(lockPath, JSON.stringify({ ...lock, pid: 999_999 }));
        const failure = Object.assign(new Error("Directory flush failed."), { code: "EIO" });
        const deniedPath = stage === "receipt" ? session.sessionDir : path.dirname(activePath);
        vi.mocked(fileUtils.syncDirectory).mockImplementation(async (directory) => {
          if (directory === deniedPath) throw failure;
          await actual.syncDirectory(directory);
        });

        await expect(recoverActiveSession(dir, DEFAULT_CONFIG)).rejects.toBe(failure);
        expect(await pathExists(activePath)).toBe(stage === "receipt");
        expect(await pathExists(lockPath)).toBe(true);
        expect(await pathExists(path.join(session.sessionDir, "session-cleanup.json"))).toBe(true);
        const reportPath = path.join(session.sessionDir, "session.json");
        const reportBytes = await readFile(reportPath, "utf8");
        vi.mocked(fileUtils.syncDirectory).mockImplementation(actual.syncDirectory);

        await expect(recoverActiveSession(dir, DEFAULT_CONFIG)).resolves.toEqual({ state: "already-complete" });
        expect(await readFile(reportPath, "utf8")).toBe(reportBytes);
        expect(await pathExists(lockPath)).toBe(false);
      } finally {
        vi.mocked(fileUtils.syncDirectory).mockImplementation(actual.syncDirectory);
        await removeTempDir(dir);
      }
    }
  );

  it("does not publish completion or discard ownership when evidence flushing fails", async () => {
    const dir = await createTempDir();
    try {
      initGitRepo(dir);
      const session = await createSession(dir, DEFAULT_CONFIG);
      const failure = Object.assign(new Error("Evidence flush failed."), { code: "EIO" });
      vi.mocked(fileUtils.syncRegularFile).mockRejectedValueOnce(failure);
      await expect(finalizeSession(session, DEFAULT_CONFIG, "test")).rejects.toBe(failure);
      expect(await pathExists(path.join(session.sessionDir, "session-metadata.json"))).toBe(false);
      expect(await pathExists(getActiveSessionPath(dir, DEFAULT_CONFIG))).toBe(true);
      expect(await pathExists(getSessionLockPath(dir, DEFAULT_CONFIG))).toBe(true);
      await expect(finalizeSession(session, DEFAULT_CONFIG, "retry")).resolves.toMatchObject({ id: session.id });
    } finally {
      await removeTempDir(dir);
    }
  });

  it("preserves empty-log finalization when evidence files were already absent", async () => {
    const dir = await createTempDir();
    try {
      initGitRepo(dir);
      const session = await createSession(dir, DEFAULT_CONFIG);
      await rm(path.join(session.sessionDir, "events.ndjson"));
      await rm(path.join(session.sessionDir, "commands.ndjson"));
      await expect(finalizeSession(session, DEFAULT_CONFIG, "test")).resolves.toMatchObject({
        events: [],
        commands: [],
      });
      expect(await pathExists(getActiveSessionPath(dir, DEFAULT_CONFIG))).toBe(false);
    } finally {
      await removeTempDir(dir);
    }
  });

  it("recovers after primary lock deletion fails without rewriting completed evidence", async () => {
    const dir = await createTempDir();
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    try {
      initGitRepo(dir);
      const session = await createSession(dir, DEFAULT_CONFIG);
      const lock = await readSessionLock(dir, DEFAULT_CONFIG);
      await writeFile(getActiveSessionPath(dir, DEFAULT_CONFIG), JSON.stringify({ ...session, pid: 999_999 }));
      const lockPath = getSessionLockPath(dir, DEFAULT_CONFIG);
      await writeFile(lockPath, JSON.stringify({ ...lock, pid: 999_999 }));
      const failure = Object.assign(new Error("Lock deletion denied."), { code: "EACCES" });
      vi.mocked(fs.rm).mockImplementation(async (filePath, options) => {
        if (filePath === lockPath) throw failure;
        return actual.rm(filePath, options);
      });

      await expect(recoverActiveSession(dir, DEFAULT_CONFIG)).rejects.toBe(failure);
      expect(await pathExists(getActiveSessionPath(dir, DEFAULT_CONFIG))).toBe(false);
      expect(await pathExists(lockPath)).toBe(true);
      const receiptPath = path.join(session.sessionDir, "session-cleanup.json");
      expect(await pathExists(receiptPath)).toBe(true);
      const reportPath = path.join(session.sessionDir, "session.json");
      const evidence = await readFile(reportPath, "utf8");
      vi.mocked(fs.rm).mockImplementation(actual.rm);

      await expect(inspectSessionRecoveryState(dir, DEFAULT_CONFIG)).resolves.toMatchObject({
        status: "already-complete",
        active: { id: session.id },
      });
      await expect(recoverActiveSession(dir, DEFAULT_CONFIG)).resolves.toEqual({ state: "already-complete" });
      expect(await readFile(reportPath, "utf8")).toBe(evidence);
      expect(await pathExists(lockPath)).toBe(false);
      expect(await pathExists(receiptPath)).toBe(false);
      await expect(createSession(dir, DEFAULT_CONFIG)).resolves.toMatchObject({ repoRoot: dir });
    } finally {
      vi.mocked(fs.rm).mockImplementation(actual.rm);
      await removeTempDir(dir);
    }
  });

  it.each([
    "missing",
    "malformed",
    "directory",
    "oversized",
    "owner",
    "location",
    "report",
    "timestamp",
    "report-identity",
  ])("preserves an orphan lock when cleanup proof is %s", async (kind) => {
    const dir = await createTempDir();
    try {
      const { session, receiptPath } = await completedCleanupFixture(dir);
      const lockPath = getSessionLockPath(dir, DEFAULT_CONFIG);
      const lockBytes = await readFile(lockPath, "utf8");
      if (kind === "missing") await rm(receiptPath);
      if (kind === "malformed") await writeFile(receiptPath, "{not-json}");
      if (kind === "directory") {
        await rm(receiptPath);
        await mkdir(receiptPath);
      }
      if (kind === "oversized") await writeFile(receiptPath, " ".repeat(1024 * 1024 + 1));
      if (kind === "owner")
        await writeFile(
          receiptPath,
          JSON.stringify({
            cleanupVersion: 1,
            active: {
              ...session,
              ownerToken: "00000000-0000-4000-8000-000000000000",
            },
          })
        );
      if (kind === "location")
        await writeFile(
          receiptPath,
          JSON.stringify({
            cleanupVersion: 1,
            active: {
              ...session,
              sessionDir: dir,
            },
          })
        );
      if (kind === "report") await writeFile(path.join(session.sessionDir, "session.json"), "{not-json}");
      if (kind === "timestamp") {
        const lock = await readSessionLock(dir, DEFAULT_CONFIG);
        await writeFile(lockPath, JSON.stringify({ ...lock, createdAt: "2025-01-01T00:00:00.000Z" }));
      }
      if (kind === "report-identity") {
        const reportPath = path.join(session.sessionDir, "session.json");
        const report = JSON.parse(await readFile(reportPath, "utf8"));
        await writeFile(reportPath, JSON.stringify({ ...report, repoRoot: `${dir}/another-repository` }));
      }

      const expectedLock = kind === "timestamp" ? await readFile(lockPath, "utf8") : lockBytes;
      const state = await inspectSessionRecoveryState(dir, DEFAULT_CONFIG);
      expect(["corrupt", "inconsistent"]).toContain(state.status);
      await expect(recoverActiveSession(dir, DEFAULT_CONFIG)).rejects.toThrow();
      expect(await readFile(lockPath, "utf8")).toBe(expectedLock);
    } finally {
      await removeTempDir(dir);
    }
  });

  it("preserves both ownership files if exclusive cleanup receipt publication fails", async () => {
    const dir = await createTempDir();
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    try {
      initGitRepo(dir);
      const session = await createSession(dir, DEFAULT_CONFIG);
      const lock = await readSessionLock(dir, DEFAULT_CONFIG);
      const activePath = getActiveSessionPath(dir, DEFAULT_CONFIG);
      const lockPath = getSessionLockPath(dir, DEFAULT_CONFIG);
      await writeFile(activePath, JSON.stringify({ ...session, pid: 999_999 }));
      await writeFile(lockPath, JSON.stringify({ ...lock, pid: 999_999 }));
      const before = await Promise.all([readFile(activePath, "utf8"), readFile(lockPath, "utf8")]);
      const failure = Object.assign(new Error("Receipt publication failed."), { code: "EIO" });
      vi.mocked(fs.link).mockImplementation(async (from, to) => {
        if (to === path.join(session.sessionDir, "session-cleanup.json")) throw failure;
        return actual.link(from, to);
      });

      await expect(recoverActiveSession(dir, DEFAULT_CONFIG)).rejects.toBe(failure);
      expect(await Promise.all([readFile(activePath, "utf8"), readFile(lockPath, "utf8")])).toEqual(before);
      expect(await pathExists(path.join(session.sessionDir, "session-cleanup.json"))).toBe(false);
      vi.mocked(fs.link).mockImplementation(actual.link);
      await expect(recoverActiveSession(dir, DEFAULT_CONFIG)).resolves.toEqual({ state: "already-complete" });
    } finally {
      vi.mocked(fs.link).mockImplementation(actual.link);
      await removeTempDir(dir);
    }
  });

  it("serializes two recoveries of the same interrupted cleanup", async () => {
    const dir = await createTempDir();
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    let releaseLockRemoval: (() => void) | undefined;
    let first: ReturnType<typeof recoverActiveSession> | undefined;
    try {
      const { session } = await completedCleanupFixture(dir);
      const lockPath = getSessionLockPath(dir, DEFAULT_CONFIG);
      vi.mocked(fs.rm).mockImplementation(async (filePath, options) => {
        if (filePath === lockPath)
          await new Promise<void>((resolve) => {
            releaseLockRemoval = resolve;
          });
        return actual.rm(filePath, options);
      });
      first = recoverActiveSession(dir, DEFAULT_CONFIG);
      await vi.waitFor(() => expect(releaseLockRemoval).toBeDefined(), { timeout: 10_000 });
      await expect(recoverActiveSession(dir, DEFAULT_CONFIG)).rejects.toThrow("already being finalized");
      await expect(createSession(dir, DEFAULT_CONFIG)).rejects.toThrow("before starting another");
      releaseLockRemoval?.();
      await expect(first).resolves.toEqual({ state: "already-complete" });
      expect(await pathExists(path.join(session.sessionDir, "session-cleanup.json"))).toBe(false);
    } finally {
      releaseLockRemoval?.();
      await first?.catch(() => undefined);
      vi.mocked(fs.rm).mockImplementation(actual.rm);
      await removeTempDir(dir);
    }
  });

  it("leaves a replacement session untouched after releasing the previous primary lock", async () => {
    const dir = await createTempDir();
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    try {
      const { receiptPath } = await completedCleanupFixture(dir);
      let replacementId: string | undefined;
      vi.mocked(fs.rm).mockImplementation(async (filePath, options) => {
        if (filePath === receiptPath) {
          const replacement = await createSession(dir, DEFAULT_CONFIG);
          replacementId = replacement.id;
          await writeStopRequest(dir, DEFAULT_CONFIG, replacement.id);
        }
        return actual.rm(filePath, options);
      });
      await expect(recoverActiveSession(dir, DEFAULT_CONFIG)).resolves.toEqual({ state: "already-complete" });
      const state = await inspectSessionRecoveryState(dir, DEFAULT_CONFIG);
      expect(state.status).toBe("active");
      expect(state.active?.id).toBe(replacementId);
      expect((await readSessionLock(dir, DEFAULT_CONFIG))?.sessionId).toBe(replacementId);
      const stopRequest = JSON.parse(
        await readFile(path.join(path.dirname(getActiveSessionPath(dir, DEFAULT_CONFIG)), "stop-request.json"), "utf8")
      );
      expect(stopRequest.sessionId).toBe(replacementId);
    } finally {
      vi.mocked(fs.rm).mockImplementation(actual.rm);
      await removeTempDir(dir);
    }
  });

  it("does not recover through a linked session directory or mutate its target", async () => {
    const dir = await createTempDir();
    const outside = await createTempDir();
    try {
      const { session } = await completedCleanupFixture(dir);
      const target = path.join(outside, "evidence");
      await rename(session.sessionDir, target);
      await symlink(target, session.sessionDir, "junction");
      const receiptBytes = await readFile(path.join(target, "session-cleanup.json"), "utf8");
      await expect(recoverActiveSession(dir, DEFAULT_CONFIG)).rejects.toThrow("cleanup proof");
      expect(await readFile(path.join(target, "session-cleanup.json"), "utf8")).toBe(receiptBytes);
      expect(await pathExists(getSessionLockPath(dir, DEFAULT_CONFIG))).toBe(true);
    } finally {
      await removeTempDir(dir);
      await removeTempDir(outside);
    }
  });

  it("refuses a valid cleanup receipt while the primary owner is still alive", async () => {
    const dir = await createTempDir();
    try {
      const { session, receiptPath } = await completedCleanupFixture(dir);
      const lockPath = getSessionLockPath(dir, DEFAULT_CONFIG);
      const lock = await readSessionLock(dir, DEFAULT_CONFIG);
      await writeFile(lockPath, JSON.stringify({ ...lock, pid: process.pid }));
      await writeFile(receiptPath, JSON.stringify({ cleanupVersion: 1, active: { ...session, pid: process.pid } }));
      await expect(recoverActiveSession(dir, DEFAULT_CONFIG)).rejects.toThrow();
      expect(await pathExists(lockPath)).toBe(true);
      expect(await pathExists(receiptPath)).toBe(true);
    } finally {
      await removeTempDir(dir);
    }
  });
});
