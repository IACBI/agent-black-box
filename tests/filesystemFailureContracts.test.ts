import * as fs from "node:fs/promises";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { configExists, getConfigPath, loadConfigWithMeta } from "../src/config/config.js";
import { DEFAULT_CONFIG } from "../src/config/defaults.js";
import { digestNdjsonRecords, isCapturedFileEvent, readNdjsonRecords } from "../src/session/ndjson.js";
import {
  createSession,
  getActiveSessionPath,
  getSessionLockPath,
  inspectSessionRecoveryState,
} from "../src/session/sessionManager.js";
import { pathExists } from "../src/utils/files.js";
import { createTempDir, initGitRepo, removeTempDir } from "./testUtils.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, access: vi.fn(actual.access) };
});

describe("filesystem failure contracts", () => {
  it("distinguishes existing paths from missing paths and non-directory ancestors", async () => {
    const dir = await createTempDir();
    try {
      const filePath = path.join(dir, "file.txt");
      await writeFile(filePath, "existing");

      await expect(pathExists(dir)).resolves.toBe(true);
      await expect(pathExists(filePath)).resolves.toBe(true);
      await expect(pathExists(path.join(dir, "missing.txt"))).resolves.toBe(false);
      await expect(pathExists(path.join(filePath, "child.txt"))).resolves.toBe(false);
    } finally {
      await removeTempDir(dir);
    }
  });

  it.each(["ENOENT", "ENOTDIR"])("treats %s as absence on every platform", async (code) => {
    vi.mocked(fs.access).mockRejectedValueOnce(Object.assign(new Error("Path is absent."), { code }));
    await expect(pathExists("missing-path")).resolves.toBe(false);
  });

  it.each(["EACCES", "EIO"])("preserves the original %s failure", async (code) => {
    const failure = Object.assign(new Error("Cannot inspect path."), { code });
    vi.mocked(fs.access).mockRejectedValueOnce(failure);
    await expect(pathExists("unreadable-path")).rejects.toBe(failure);
  });

  it("refuses default configuration fallback when an existing config cannot be inspected", async () => {
    const dir = await createTempDir();
    try {
      const configPath = getConfigPath(dir);
      const contents = JSON.stringify({ ...DEFAULT_CONFIG, exclude: ["private"] });
      await writeFile(configPath, contents);
      const failure = Object.assign(new Error("Config access denied."), { code: "EACCES" });

      vi.mocked(fs.access).mockRejectedValueOnce(failure);
      await expect(configExists(dir)).rejects.toBe(failure);
      vi.mocked(fs.access).mockRejectedValueOnce(failure);
      await expect(loadConfigWithMeta(dir)).rejects.toBe(failure);
      expect(await readFile(configPath, "utf8")).toBe(contents);
    } finally {
      await removeTempDir(dir);
    }
  });

  it("refuses to read or verify inaccessible evidence as an empty log", async () => {
    const dir = await createTempDir();
    try {
      const logPath = path.join(dir, "events.ndjson");
      const contents = `${JSON.stringify({
        timestamp: "2026-01-01T00:00:00.000Z",
        eventType: "change",
        path: "src/index.ts",
      })}\n`;
      await writeFile(logPath, contents);
      const failure = Object.assign(new Error("Log inspection failed."), { code: "EIO" });

      vi.mocked(fs.access).mockRejectedValueOnce(failure);
      await expect(readNdjsonRecords(logPath, isCapturedFileEvent, "file event")).rejects.toBe(failure);
      vi.mocked(fs.access).mockRejectedValueOnce(failure);
      await expect(digestNdjsonRecords(logPath, isCapturedFileEvent, "file event")).rejects.toBe(failure);
      expect(await readFile(logPath, "utf8")).toBe(contents);
    } finally {
      await removeTempDir(dir);
    }
  });

  it.each(["active", "lock"])("reports inaccessible %s ownership as corrupt and preserves state", async (kind) => {
    const dir = await createTempDir();
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    try {
      initGitRepo(dir);
      await createSession(dir, DEFAULT_CONFIG);
      const activePath = getActiveSessionPath(dir, DEFAULT_CONFIG);
      const lockPath = getSessionLockPath(dir, DEFAULT_CONFIG);
      const [activeContents, lockContents] = await Promise.all([
        readFile(activePath, "utf8"),
        readFile(lockPath, "utf8"),
      ]);
      const failure = Object.assign(new Error("Session access denied."), { code: "EACCES" });
      const deniedPath = kind === "active" ? activePath : lockPath;
      vi.mocked(fs.access).mockImplementation(async (filePath, mode) => {
        if (filePath === deniedPath) {
          throw failure;
        }
        return actual.access(filePath, mode);
      });

      await expect(inspectSessionRecoveryState(dir, DEFAULT_CONFIG)).resolves.toMatchObject({
        status: "corrupt",
        active: null,
      });
      expect(await readFile(activePath, "utf8")).toBe(activeContents);
      expect(await readFile(lockPath, "utf8")).toBe(lockContents);
    } finally {
      vi.mocked(fs.access).mockImplementation(actual.access);
      await removeTempDir(dir);
    }
  });
});
