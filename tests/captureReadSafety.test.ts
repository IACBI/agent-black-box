import { appendFileSync, renameSync, writeFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { digestNdjsonRecords, isCapturedFileEvent, readNdjsonRecords } from "../src/session/ndjson.js";
import type { FileEvent } from "../src/types.js";
import { createTempDir, removeTempDir } from "./testUtils.js";

const event = { timestamp: "2026-01-05T00:00:00.000Z", eventType: "change", path: "src/app.ts" };

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, open: vi.fn(actual.open) };
});

describe("capture log read identity", () => {
  afterEach(() => vi.restoreAllMocks());

  it("preserves both a quota failure and a descriptor close failure", async () => {
    const dir = await createTempDir("abb-capture-close-");
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    const quota = new Error("record allowance refused");
    const closeFailure = new Error("descriptor close failed");
    try {
      const log = path.join(dir, "events.ndjson");
      await writeFile(log, `${JSON.stringify(event)}\n`);
      vi.mocked(fs.open).mockImplementationOnce(async (...args) => {
        const handle = await actual.open(...args);
        const close = handle.close.bind(handle);
        vi.spyOn(handle, "close").mockImplementationOnce(async () => {
          await close();
          throw closeFailure;
        });
        return handle;
      });
      const failure = await readNdjsonRecords(log, isCapturedFileEvent, "file event", () => {
        throw quota;
      }).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(AggregateError);
      expect((failure as AggregateError).errors).toEqual([quota, closeFailure]);
      expect(await readFile(log, "utf8")).toBe(`${JSON.stringify(event)}\n`);
    } finally {
      await removeTempDir(dir);
    }
  });

  it("checks pathname identity after parsing an unterminated final record", async () => {
    const dir = await createTempDir("abb-capture-final-record-");
    try {
      const log = path.join(dir, "events.ndjson");
      await writeFile(log, JSON.stringify(event));
      const guard = (value: unknown): value is FileEvent => {
        renameSync(log, `${log}.original`);
        writeFileSync(log, JSON.stringify({ ...event, path: "replacement.ts" }));
        return isCapturedFileEvent(value);
      };
      await expect(readNdjsonRecords(log, guard, "file event")).rejects.toThrow("changed");
    } finally {
      await removeTempDir(dir);
    }
  });
  it.each(["read", "digest"])("refuses a directory during %s", async (mode) => {
    const dir = await createTempDir("abb-capture-read-");
    try {
      const log = path.join(dir, "events.ndjson");
      await mkdir(log);
      const read = mode === "read" ? readNdjsonRecords : digestNdjsonRecords;
      await expect(read(log, isCapturedFileEvent, "file event")).rejects.toThrow();
    } finally {
      await removeTempDir(dir);
    }
  });

  it.skipIf(process.platform === "win32").each(["read", "digest"])(
    "refuses linked capture logs during %s",
    async (mode) => {
      const dir = await createTempDir("abb-capture-read-");
      try {
        const target = path.join(dir, "outside.ndjson");
        const link = path.join(dir, "events.ndjson");
        const contents = `${JSON.stringify(event)}\n`;
        await writeFile(target, contents);
        await symlink(target, link);
        const read = mode === "read" ? readNdjsonRecords : digestNdjsonRecords;
        await expect(read(link, isCapturedFileEvent, "file event")).rejects.toThrow("regular");
        expect(await readFile(target, "utf8")).toBe(contents);
      } finally {
        await removeTempDir(dir);
      }
    }
  );

  it.each(["read", "digest"])(
    "rejects a replaced pathname during %s instead of returning stale evidence",
    async (mode) => {
      const dir = await createTempDir("abb-capture-read-");
      try {
        const log = path.join(dir, "events.ndjson");
        const original = `${JSON.stringify(event)}\n`;
        const replacement = `${JSON.stringify({ ...event, path: "src/replacement.ts" })}\n`;
        await writeFile(log, original);
        let swapped = false;
        const guard = (value: unknown): value is FileEvent => {
          if (!swapped) {
            swapped = true;
            renameSync(log, `${log}.original`);
            writeFileSync(log, replacement);
          }
          return isCapturedFileEvent(value);
        };
        const read = mode === "read" ? readNdjsonRecords : digestNdjsonRecords;
        await expect(read(log, guard, "file event")).rejects.toThrow("changed");
        expect(await readFile(`${log}.original`, "utf8")).toBe(original);
        expect(await readFile(log, "utf8")).toBe(replacement);
      } finally {
        await removeTempDir(dir);
      }
    }
  );

  it.each(["read", "digest"])("rejects a log appended while %s is in progress", async (mode) => {
    const dir = await createTempDir("abb-capture-read-");
    try {
      const log = path.join(dir, "events.ndjson");
      const line = `${JSON.stringify(event)}\n`;
      await writeFile(log, line);
      let appended = false;
      const guard = (value: unknown): value is FileEvent => {
        if (!appended) {
          appended = true;
          appendFileSync(log, line);
        }
        return isCapturedFileEvent(value);
      };
      const read = mode === "read" ? readNdjsonRecords : digestNdjsonRecords;
      await expect(read(log, guard, "file event")).rejects.toThrow("changed");
      expect(await readFile(log, "utf8")).toBe(line.repeat(2));
    } finally {
      await removeTempDir(dir);
    }
  });
});
