import { appendFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  digestRegularFile,
  digestText,
  MaterializationBudgetError,
  readJsonFileWithinBudget,
} from "../src/session/reportStorage.js";
import * as files from "../src/utils/files.js";
import { createTempDir, removeTempDir } from "./testUtils.js";

describe("report storage input quotas", () => {
  it("preserves format limits and malformed JSON errors instead of reporting corruption as quota refusal", async () => {
    const directory = await createTempDir("abb-report-storage-");
    const filePath = path.join(directory, "session.json");
    try {
      await writeFile(filePath, "{ invalid }");
      await expect(readJsonFileWithinBudget(filePath, 64, 64)).rejects.toBeInstanceOf(SyntaxError);
      await writeFile(filePath, " ".repeat(65));
      await expect(readJsonFileWithinBudget(filePath, 64, 32)).rejects.toThrow("64 bytes size limit");
      await writeFile(filePath, JSON.stringify({ value: "x".repeat(32) }));
      await expect(readJsonFileWithinBudget(filePath, 64, 32)).rejects.toBeInstanceOf(MaterializationBudgetError);
    } finally {
      await removeTempDir(directory);
    }
  });

  it("bounds a file that grows after quota preflight and keeps its quota failure distinct", async () => {
    const directory = await createTempDir("abb-report-growth-");
    const filePath = path.join(directory, "session.json");
    const readFileLimited = files.readFileLimited;
    let restoreReader: (() => void) | undefined;
    try {
      await writeFile(filePath, "{}");
      const reader = vi.spyOn(files, "readFileLimited").mockImplementation(async (target, maxBytes) => {
        await appendFile(target, " ".repeat(32));
        return readFileLimited(target, maxBytes);
      });
      restoreReader = () => reader.mockRestore();
      await expect(readJsonFileWithinBudget(filePath, 64, 16)).rejects.toBeInstanceOf(MaterializationBudgetError);
    } finally {
      restoreReader?.();
      await removeTempDir(directory);
    }
  });

  it("hashes the exact file bytes and refuses unsupported digest size before streaming", async () => {
    const directory = await createTempDir("abb-report-digest-");
    const filePath = path.join(directory, "session.json");
    const text = '{"name":"Türkçe"}\n';
    try {
      await writeFile(filePath, text);
      const bytes = Buffer.byteLength(text);
      await expect(digestRegularFile(filePath, bytes)).resolves.toEqual({ bytes, digest: digestText(text) });
      await expect(digestRegularFile(filePath, bytes - 1)).rejects.toThrow("digest size limit");
      await expect(digestRegularFile(filePath, -1)).rejects.toThrow("non-negative safe integer");
    } finally {
      await removeTempDir(directory);
    }
  });
});
