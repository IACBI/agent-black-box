import { writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  digestNdjsonRecords,
  isCapturedCommandEvent,
  isCapturedFileEvent,
  readNdjsonRecords,
} from "../src/session/ndjson.js";
import { digestRecords } from "../src/session/reportStorage.js";
import type { FileEvent } from "../src/types.js";
import { createTempDir, removeTempDir } from "./testUtils.js";

const event = { timestamp: "2026-01-05T00:00:00.000Z", eventType: "change", path: "src/index.ts" };

describe("streaming NDJSON digests", () => {
  it("propagates record serialization failures rather than discarding accepted records", async () => {
    const dir = await createTempDir("abb-ndjson-errors-");
    try {
      const filePath = path.join(dir, "events.ndjson");
      await writeFile(filePath, `${JSON.stringify(event)}\n`);
      const failingSerializationGuard = (value: unknown): value is FileEvent => {
        if (!isCapturedFileEvent(value)) {
          return false;
        }
        Object.defineProperty(value, "toJSON", {
          value: () => {
            throw new Error("injected serialization failure");
          },
        });
        return true;
      };

      await expect(digestNdjsonRecords(filePath, failingSerializationGuard, "file event")).rejects.toThrow(
        "injected serialization failure"
      );
    } finally {
      await removeTempDir(dir);
    }
  });

  it("matches materialized canonical records including extra fields, UTF-8, CRLF, and an unterminated last line", async () => {
    const dir = await createTempDir("abb-ndjson-");
    try {
      const filePath = path.join(dir, "events.ndjson");
      const extra = { ...event, extra: { label: "変更", padding: "x".repeat(70_000) } };
      await writeFile(filePath, `\r\n${JSON.stringify(extra, null, 0)}\r\ninvalid\n${JSON.stringify(event)}`);

      const read = await readNdjsonRecords(filePath, isCapturedFileEvent, "file event");
      const streamed = await digestNdjsonRecords(filePath, isCapturedFileEvent, "file event");

      expect(read.records).toEqual([extra, event]);
      expect(streamed).toEqual({
        recordCount: 2,
        discardedLines: read.discardedLines,
        warnings: read.warnings,
        digest: digestRecords(read.records),
      });
      expect(streamed).not.toHaveProperty("records");
      await writeFile(
        filePath,
        `\r\n${JSON.stringify({ ...extra, extra: { ...extra.extra, label: "改変" } })}\r\ninvalid\n${JSON.stringify(event)}`
      );
      expect((await digestNdjsonRecords(filePath, isCapturedFileEvent, "file event")).digest).not.toBe(streamed.digest);
    } finally {
      await removeTempDir(dir);
    }
  });

  it("preserves oversized, malformed, and warning-limit diagnostics", async () => {
    const dir = await createTempDir("abb-ndjson-");
    try {
      const filePath = path.join(dir, "events.ndjson");
      await writeFile(
        filePath,
        `${"x".repeat(1024 * 1024 + 1)}\n{}\n${"invalid\n".repeat(110)}${JSON.stringify(event)}\n`
      );
      const read = await readNdjsonRecords(filePath, isCapturedFileEvent, "file event");
      const streamed = await digestNdjsonRecords(filePath, isCapturedFileEvent, "file event");

      expect(streamed.recordCount).toBe(1);
      expect(streamed.discardedLines).toBe(112);
      expect(streamed.warnings).toEqual(read.warnings);
      expect(streamed.warnings).toHaveLength(101);
      expect(streamed.digest).toBe(digestRecords(read.records));
    } finally {
      await removeTempDir(dir);
    }
  });

  it("uses the existing accepted-record limit while continuing discarded-line counts", async () => {
    const dir = await createTempDir("abb-ndjson-limit-");
    try {
      const filePath = path.join(dir, "numbers.ndjson");
      const isNumber = (value: unknown): value is number => typeof value === "number";
      await writeFile(filePath, "1\n".repeat(1_000_002));
      const read = await readNdjsonRecords(filePath, isNumber, "number");
      const streamed = await digestNdjsonRecords(filePath, isNumber, "number");

      expect(streamed.recordCount).toBe(1_000_000);
      expect(streamed.discardedLines).toBe(2);
      expect(streamed.warnings).toEqual(read.warnings);
      expect(streamed.digest).toBe(digestRecords(read.records));
    } finally {
      await removeTempDir(dir);
    }
  }, 30_000);

  it("matches command record digests and hashes missing logs as an empty array", async () => {
    const dir = await createTempDir("abb-ndjson-commands-");
    try {
      const filePath = path.join(dir, "commands.ndjson");
      expect(await digestNdjsonRecords(filePath, isCapturedCommandEvent, "command event")).toEqual({
        recordCount: 0,
        discardedLines: 0,
        warnings: [],
        digest: digestRecords([]),
      });
      const command = {
        startedAt: event.timestamp,
        endedAt: event.timestamp,
        command: "node --version",
        cwd: ".",
        exitCode: 0,
        durationMs: 1,
        extra: ["retained", 42],
      };
      await writeFile(filePath, `${JSON.stringify(command)}\n${JSON.stringify({ ...command, durationMs: -1 })}\n`);
      const read = await readNdjsonRecords(filePath, isCapturedCommandEvent, "command event");
      expect(await digestNdjsonRecords(filePath, isCapturedCommandEvent, "command event")).toEqual({
        recordCount: 1,
        discardedLines: 1,
        warnings: read.warnings,
        digest: digestRecords([command]),
      });
    } finally {
      await removeTempDir(dir);
    }
  });
});
