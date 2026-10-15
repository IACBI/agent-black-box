import * as fs from "node:fs/promises";
import { readdir } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG } from "../src/config/defaults.js";
import {
  createSession,
  getActiveSessionPath,
  getSessionLockPath,
  getSessionRoot,
} from "../src/session/sessionManager.js";
import { pathExists } from "../src/utils/files.js";
import { createTempDir, initGitRepo, removeTempDir } from "./testUtils.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, writeFile: vi.fn(actual.writeFile), rm: vi.fn(actual.rm) };
});

describe("session start failure", () => {
  it("removes the unpublished session directory and releases the lock so a retry succeeds", async () => {
    const dir = await createTempDir();
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    try {
      initGitRepo(dir);
      const failure = Object.assign(new Error("No space left on device."), { code: "ENOSPC" });
      vi.mocked(fs.writeFile).mockImplementation(async (target, ...rest) => {
        if (String(target).endsWith("commands.ndjson")) throw failure;
        return actual.writeFile(target, ...rest);
      });

      await expect(createSession(dir, DEFAULT_CONFIG)).rejects.toBe(failure);

      expect(await readdir(getSessionRoot(dir, DEFAULT_CONFIG))).toEqual([]);
      expect(await pathExists(getSessionLockPath(dir, DEFAULT_CONFIG))).toBe(false);
      expect(await pathExists(getActiveSessionPath(dir, DEFAULT_CONFIG))).toBe(false);

      vi.mocked(fs.writeFile).mockImplementation(actual.writeFile);
      const retry = await createSession(dir, DEFAULT_CONFIG);
      expect(await readdir(getSessionRoot(dir, DEFAULT_CONFIG))).toEqual([retry.id]);
    } finally {
      vi.mocked(fs.writeFile).mockImplementation(actual.writeFile);
      await removeTempDir(dir);
    }
  });
  it("reports a failed directory removal alongside the start error and still releases the lock", async () => {
    const dir = await createTempDir();
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    try {
      initGitRepo(dir);
      const startFailure = Object.assign(new Error("No space left on device."), { code: "ENOSPC" });
      const removalFailure = Object.assign(new Error("Permission denied."), { code: "EPERM" });
      vi.mocked(fs.writeFile).mockImplementation(async (target, ...rest) => {
        if (String(target).endsWith("commands.ndjson")) throw startFailure;
        return actual.writeFile(target, ...rest);
      });
      vi.mocked(fs.rm).mockRejectedValueOnce(removalFailure);

      const failure = await createSession(dir, DEFAULT_CONFIG).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(AggregateError);
      expect((failure as AggregateError).errors).toEqual([startFailure, removalFailure]);
      expect(await pathExists(getSessionLockPath(dir, DEFAULT_CONFIG))).toBe(false);
    } finally {
      vi.mocked(fs.writeFile).mockImplementation(actual.writeFile);
      await removeTempDir(dir);
    }
  });
});
