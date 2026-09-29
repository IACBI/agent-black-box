import * as fs from "node:fs/promises";
import { symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { inspectTextFile, isLikelyBinary } from "../src/utils/fileInspection.js";
import { createTempDir, removeTempDir } from "./testUtils.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, open: vi.fn(actual.open), realpath: vi.fn(actual.realpath) };
});

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
        text: "hello\n",
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
        sizeBytes: 128,
      });
    } finally {
      await removeTempDir(dir);
    }
  });

  it.each(["ENOENT", "ENOTDIR"])("classifies a file that disappears before opening (%s) as missing", async (code) => {
    const dir = await createTempDir();
    try {
      const filePath = path.join(dir, "changing.txt");
      await writeFile(filePath, "hello", "utf8");
      vi.mocked(fs.open).mockRejectedValueOnce(Object.assign(new Error("File disappeared."), { code }));

      await expect(inspectTextFile(filePath, 1024)).resolves.toMatchObject({ kind: "missing" });
    } finally {
      await removeTempDir(dir);
    }
  });

  it.each(["ENOENT", "ENOTDIR"])("classifies a disappearing trusted ancestor (%s) as missing", async (code) => {
    const dir = await createTempDir();
    try {
      const filePath = path.join(dir, "changing.txt");
      await writeFile(filePath, "hello", "utf8");
      vi.mocked(fs.realpath).mockRejectedValueOnce(Object.assign(new Error("Ancestor disappeared."), { code }));

      await expect(inspectTextFile(filePath, 1024, undefined, dir)).resolves.toMatchObject({ kind: "missing" });
    } finally {
      await removeTempDir(dir);
    }
  });

  it("preserves file permission errors during inspection", async () => {
    const dir = await createTempDir();
    try {
      const filePath = path.join(dir, "restricted.txt");
      await writeFile(filePath, "hello", "utf8");
      const permissionError = Object.assign(new Error("Permission denied."), { code: "EACCES" });
      vi.mocked(fs.open).mockRejectedValueOnce(permissionError);

      await expect(inspectTextFile(filePath, 1024)).rejects.toBe(permissionError);
    } finally {
      await removeTempDir(dir);
    }
  });

  it.skipIf(process.platform === "win32")("does not follow symbolic links", async () => {
    const dir = await createTempDir();
    try {
      const targetPath = path.join(dir, "target.txt");
      const linkPath = path.join(dir, "link.txt");
      await writeFile(targetPath, "outside contents", "utf8");
      await symlink(targetPath, linkPath, "file");

      await expect(inspectTextFile(linkPath, 1024)).resolves.toMatchObject({ kind: "not-file" });
    } finally {
      await removeTempDir(dir);
    }
  });

  it("does not inspect files through an ancestor link outside the trusted repository", async () => {
    const repo = await createTempDir();
    const outside = await createTempDir();
    try {
      await writeFile(path.join(outside, "data.txt"), "external content", "utf8");
      const linked = path.join(repo, "linked");
      await symlink(outside, linked, process.platform === "win32" ? "junction" : "dir");

      await expect(inspectTextFile(path.join(linked, "data.txt"), 1024, undefined, repo)).resolves.toMatchObject({
        kind: "not-file",
        reason: "Path resolves outside the repository.",
      });
    } finally {
      await removeTempDir(repo);
      await removeTempDir(outside);
    }
  });
});
