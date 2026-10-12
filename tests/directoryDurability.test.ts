import * as fs from "node:fs/promises";
import { readFile, readdir } from "node:fs/promises";
import * as os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { syncDirectory, syncRegularFile, writeTextFileAtomic } from "../src/utils/files.js";
import { createTempDir, removeTempDir } from "./testUtils.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, open: vi.fn(actual.open) };
});
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, platform: vi.fn(actual.platform) };
});

afterEach(async () => {
  vi.restoreAllMocks();
  const fsActual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  const osActual = await vi.importActual<typeof import("node:os")>("node:os");
  vi.mocked(fs.open).mockImplementation(fsActual.open);
  vi.mocked(os.platform).mockImplementation(osActual.platform);
});

describe("filesystem durability barriers", () => {
  it.each(["linux", "darwin"] as const)("flushes directory entries on %s", async (platform) => {
    vi.mocked(os.platform).mockReturnValueOnce(platform);
    const sync = vi.fn().mockResolvedValue(undefined);
    const close = vi.fn().mockResolvedValue(undefined);
    vi.mocked(fs.open).mockResolvedValueOnce({ sync, close } as unknown as fs.FileHandle);
    await syncDirectory("directory");
    expect(fs.open).toHaveBeenCalledWith("directory", "r");
    expect(sync).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    expect(sync.mock.invocationCallOrder[0]).toBeLessThan(close.mock.invocationCallOrder[0]!);
  });

  it("does not attempt unsupported directory handles on Windows", async () => {
    vi.mocked(os.platform).mockReturnValueOnce("win32");
    const before = vi.mocked(fs.open).mock.calls.length;
    await syncDirectory("directory");
    expect(vi.mocked(fs.open).mock.calls.length).toBe(before);
  });

  it.each(["EIO", "ENOTSUP", "EACCES"])("preserves a directory %s failure and closes its handle", async (code) => {
    vi.mocked(os.platform).mockReturnValueOnce("linux");
    const failure = Object.assign(new Error("Directory flush failed."), { code });
    const close = vi.fn().mockResolvedValue(undefined);
    vi.mocked(fs.open).mockResolvedValueOnce({
      sync: vi.fn().mockRejectedValue(failure),
      close,
    } as unknown as fs.FileHandle);
    await expect(syncDirectory("directory")).rejects.toBe(failure);
    expect(close).toHaveBeenCalledOnce();
  });

  it("retains both flush and close failures", async () => {
    vi.mocked(os.platform).mockReturnValueOnce("linux");
    const syncFailure = new Error("Flush failed.");
    const closeFailure = new Error("Close failed.");
    vi.mocked(fs.open).mockResolvedValueOnce({
      sync: vi.fn().mockRejectedValue(syncFailure),
      close: vi.fn().mockRejectedValue(closeFailure),
    } as unknown as fs.FileHandle);
    const failure: unknown = await syncDirectory("directory").catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([syncFailure, closeFailure]);
  });

  it("preserves directory-open and close-only failures", async () => {
    const openFailure = Object.assign(new Error("Directory cannot be opened."), { code: "EACCES" });
    vi.mocked(os.platform).mockReturnValueOnce("linux");
    vi.mocked(fs.open).mockRejectedValueOnce(openFailure);
    await expect(syncDirectory("directory")).rejects.toBe(openFailure);
    const closeFailure = new Error("Directory close failed.");
    vi.mocked(os.platform).mockReturnValueOnce("darwin");
    vi.mocked(fs.open).mockResolvedValueOnce({
      sync: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockRejectedValue(closeFailure),
    } as unknown as fs.FileHandle);
    await expect(syncDirectory("directory")).rejects.toBe(closeFailure);
  });

  it("closes and refuses an opened non-regular evidence file before flushing", async () => {
    const sync = vi.fn();
    const close = vi.fn().mockResolvedValue(undefined);
    vi.mocked(fs.open).mockResolvedValueOnce({
      stat: vi.fn().mockResolvedValue({ isFile: () => false }),
      sync,
      close,
    } as unknown as fs.FileHandle);
    await expect(syncRegularFile("events.ndjson")).rejects.toThrow("not a regular file");
    expect(sync).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });

  it("flushes regular evidence files and refuses directories", async () => {
    const dir = await createTempDir();
    try {
      const filePath = path.join(dir, "events.ndjson");
      await writeTextFileAtomic(filePath, "complete\n");
      const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
      let sync: ReturnType<typeof vi.spyOn> | undefined;
      let close: ReturnType<typeof vi.spyOn> | undefined;
      vi.mocked(fs.open).mockImplementationOnce(async (...args) => {
        const handle = await actual.open(...args);
        sync = vi.spyOn(handle, "sync");
        close = vi.spyOn(handle, "close");
        expect(args[1]).toBe("r+");
        return handle;
      });
      await syncRegularFile(filePath);
      expect(sync).toHaveBeenCalledOnce();
      expect(close).toHaveBeenCalledOnce();
      await expect(readFile(filePath, "utf8")).resolves.toBe("complete\n");
      await expect(syncRegularFile(dir)).rejects.toThrow();
    } finally {
      await removeTempDir(dir);
    }
  });

  it.each([true, false])(
    "keeps complete published content when the final directory barrier fails (overwrite=%s)",
    async (overwrite) => {
      const dir = await createTempDir();
      try {
        const filePath = path.join(dir, "report.md");
        const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
        const failure = Object.assign(new Error("Directory flush failed."), { code: "EIO" });
        vi.mocked(os.platform).mockReturnValue("linux");
        vi.mocked(fs.open).mockImplementation(async (...args) => {
          if (args[0] === dir) {
            // Publication must already be complete before its directory entry can be flushed.
            expect(await readFile(filePath, "utf8")).toBe("complete\n");
            return {
              sync: vi.fn().mockRejectedValue(failure),
              close: vi.fn().mockResolvedValue(undefined),
            } as unknown as fs.FileHandle;
          }
          return actual.open(...args);
        });
        await expect(writeTextFileAtomic(filePath, "complete\n", { overwrite })).rejects.toBe(failure);
        expect(await readFile(filePath, "utf8")).toBe("complete\n");
        expect(await readdir(dir)).toEqual(["report.md"]);
      } finally {
        vi.restoreAllMocks();
        await removeTempDir(dir);
      }
    }
  );
});
