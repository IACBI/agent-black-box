import * as fs from "node:fs/promises";
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { readTextFileLimited, writeJsonFile, writeTextFileAtomic } from "../src/utils/files.js";
import { createTempDir, removeTempDir } from "./testUtils.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, open: vi.fn(actual.open) };
});

describe("bounded file reads", () => {
  it("accepts exact UTF-8 byte limits and empty files", async () => {
    const dir = await createTempDir();
    try {
      const filePath = path.join(dir, "text.txt");
      await writeFile(filePath, "é");
      await expect(readTextFileLimited(filePath, 2)).resolves.toBe("é");
      await expect(readTextFileLimited(filePath, 1)).rejects.toThrow("size limit");
      await writeFile(filePath, "");
      await expect(readTextFileLimited(filePath, 0)).resolves.toBe("");
      await expect(readTextFileLimited(filePath, -1)).rejects.toThrow("non-negative safe integer");
    } finally {
      await removeTempDir(dir);
    }
  });

  it("bounds actual reads even when the reported size is stale", async () => {
    const dir = await createTempDir();
    try {
      const filePath = path.join(dir, "growing.txt");
      await writeFile(filePath, "a".repeat(1024));
      const handle = await fs.open(filePath, "r");
      const details = await handle.stat();
      details.size = 0;
      vi.spyOn(handle, "stat").mockResolvedValue(details);
      const read = vi.spyOn(handle, "read");
      const close = vi.spyOn(handle, "close");
      vi.mocked(fs.open).mockResolvedValueOnce(handle);

      await expect(readTextFileLimited(filePath, 16)).rejects.toThrow("16 bytes size limit");
      expect(read).toHaveBeenCalledTimes(1);
      expect(read.mock.calls[0][0]).toHaveLength(17);
      expect(close).toHaveBeenCalledOnce();
    } finally {
      vi.restoreAllMocks();
      await removeTempDir(dir);
    }
  });
});

describe("atomic file writes", () => {
  it("replaces text and JSON files without leaving temporary files", async () => {
    const dir = await createTempDir();
    try {
      const textPath = path.join(dir, "report.md");
      const jsonPath = path.join(dir, "state.json");

      await writeTextFileAtomic(textPath, "first");
      await writeTextFileAtomic(textPath, "second");
      await writeJsonFile(jsonPath, { state: "complete" });

      await expect(readFile(textPath, "utf8")).resolves.toBe("second");
      await expect(readFile(jsonPath, "utf8")).resolves.toBe('{\n  "state": "complete"\n}\n');
      expect((await readdir(dir)).some((name) => name.endsWith(".tmp"))).toBe(false);
    } finally {
      await removeTempDir(dir);
    }
  });

  it("publishes exclusively without replacing an existing file", async () => {
    const dir = await createTempDir();
    try {
      const filePath = path.join(dir, "config.json");
      await writeTextFileAtomic(filePath, "original", { overwrite: false });

      await expect(writeTextFileAtomic(filePath, "replacement", { overwrite: false })).rejects.toMatchObject({
        code: "EEXIST",
      });
      await expect(readFile(filePath, "utf8")).resolves.toBe("original");
      expect(await readdir(dir)).toEqual(["config.json"]);
    } finally {
      await removeTempDir(dir);
    }
  });

  it("preserves the previous file when a temporary write fails", async () => {
    const dir = await createTempDir();
    try {
      const filePath = path.join(dir, "report.md");
      await writeFile(filePath, "original");
      const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
      const failure = new Error("Simulated write failure.");
      vi.mocked(fs.open).mockImplementationOnce(async (...args) => {
        const handle = await actual.open(...args);
        vi.spyOn(handle, "writeFile").mockRejectedValueOnce(failure);
        return handle;
      });

      await expect(writeTextFileAtomic(filePath, "replacement")).rejects.toBe(failure);
      await expect(readFile(filePath, "utf8")).resolves.toBe("original");
      expect(await readdir(dir)).toEqual(["report.md"]);
    } finally {
      vi.restoreAllMocks();
      await removeTempDir(dir);
    }
  });
});
