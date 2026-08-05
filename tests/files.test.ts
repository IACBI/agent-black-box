import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { writeJsonFile, writeTextFileAtomic } from "../src/utils/files.js";
import { createTempDir, removeTempDir } from "./testUtils.js";

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
});
