import { writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { inspectTextFile, isLikelyBinary } from "../src/utils/fileInspection.js";
import { createTempDir, removeTempDir } from "./testUtils.js";

describe("file inspection", () => {
  it("detects text and binary buffers", () => {
    expect(isLikelyBinary(Buffer.from("hello\nworld\n", "utf8"))).toBe(false);
    expect(isLikelyBinary(Buffer.from([0, 1, 2, 3, 255, 0]))).toBe(true);
  });

  it("classifies regular text files with size metadata", async () => {
    const dir = await createTempDir();
    try {
      const filePath = path.join(dir, "notes.txt");
      await writeFile(filePath, "hello\n", "utf8");

      await expect(inspectTextFile(filePath, 1024)).resolves.toMatchObject({
        kind: "text",
        sizeBytes: 6,
        text: "hello\n"
      });
    } finally {
      await removeTempDir(dir);
    }
  });

  it("classifies oversized text files as large without reading full content", async () => {
    const dir = await createTempDir();
    try {
      const filePath = path.join(dir, "large.txt");
      await writeFile(filePath, "a".repeat(128), "utf8");

      await expect(inspectTextFile(filePath, 16)).resolves.toMatchObject({
        kind: "large",
        sizeBytes: 128
      });
    } finally {
      await removeTempDir(dir);
    }
  });
});
