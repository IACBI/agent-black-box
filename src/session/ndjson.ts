import { createHash } from "node:crypto";
import { constants, type BigIntStats, type ReadStream } from "node:fs";
import { lstat, open } from "node:fs/promises";
import path from "node:path";
import type { CommandEvent, FileEvent } from "../types.js";
import { pathExists } from "../utils/files.js";
import { isRecord } from "../utils/records.js";

const MAX_NDJSON_LINE_BYTES = 1024 * 1024;
const NDJSON_READ_CHUNK_BYTES = 64 * 1024;
/** Encoded line parts, their concatenated copy, and current/prefetched chunks; parsed objects are outside this policy. */
export const NDJSON_STREAM_WORKING_BYTES = 2 * MAX_NDJSON_LINE_BYTES + 2 * NDJSON_READ_CHUNK_BYTES;
const MAX_NDJSON_RECORDS = 1_000_000;
const MAX_INTEGRITY_WARNINGS = 100;
const MAX_PATH_LENGTH = 32_768;
const MAX_COMMAND_LENGTH = 32_768;
const MAX_METADATA_LENGTH = 80;

export interface NdjsonReadResult<T> {
  records: T[];
  discardedLines: number;
  warnings: string[];
}

interface NdjsonScanResult {
  recordCount: number;
  discardedLines: number;
  warnings: string[];
}

export interface NdjsonDigestResult extends NdjsonScanResult {
  digest: string;
}

export function isCapturedFileEvent(value: unknown): value is FileEvent {
  if (!isRecord(value)) {
    return false;
  }
  return (
    isIsoDate(value.timestamp) &&
    isBoundedString(value.path, MAX_PATH_LENGTH) &&
    (value.eventType === "add" || value.eventType === "change" || value.eventType === "unlink")
  );
}

export function isCapturedCommandEvent(value: unknown): value is CommandEvent {
  if (!isRecord(value)) {
    return false;
  }
  return (
    isIsoDate(value.startedAt) &&
    isIsoDate(value.endedAt) &&
    isBoundedString(value.command, MAX_COMMAND_LENGTH) &&
    isBoundedString(value.cwd, MAX_PATH_LENGTH) &&
    isOptionalBoundedString(value.label, MAX_METADATA_LENGTH) &&
    isOptionalBoundedString(value.group, MAX_METADATA_LENGTH) &&
    isOptionalBoundedString(value.phase, MAX_METADATA_LENGTH) &&
    (Number.isInteger(value.exitCode) || value.exitCode === null) &&
    typeof value.durationMs === "number" &&
    Number.isFinite(value.durationMs) &&
    value.durationMs >= 0 &&
    isOptionalBoundedString(value.error, MAX_COMMAND_LENGTH)
  );
}

export async function readNdjsonRecords<T>(
  filePath: string,
  guard: (value: unknown) => value is T,
  label: string,
  reserveRecordBytes?: (bytes: number) => void,
  checkpoint?: () => void
): Promise<NdjsonReadResult<T>> {
  const records: T[] = [];
  const result = await scanNdjsonRecords(
    filePath,
    guard,
    label,
    (record) => {
      // Reserve accepted canonical bytes before retention; policy failures are not malformed-record warnings.
      reserveRecordBytes?.(Buffer.byteLength(JSON.stringify(record), "utf8"));
      records.push(record);
    },
    checkpoint
  );
  return { records, discardedLines: result.discardedLines, warnings: result.warnings };
}

/** Hash the same canonical JSON array as digestRecords without retaining its records. */
export async function digestNdjsonRecords<T>(
  filePath: string,
  guard: (value: unknown) => value is T,
  label: string
): Promise<NdjsonDigestResult> {
  const hash = createHash("sha256");
  hash.update("[");
  const result = await scanNdjsonRecords(filePath, guard, label, (record, index) => {
    if (index > 0) {
      hash.update(",");
    }
    hash.update(JSON.stringify(record));
  });
  hash.update("]");
  return { ...result, digest: hash.digest("hex") };
}

async function scanNdjsonRecords<T>(
  filePath: string,
  guard: (value: unknown) => value is T,
  label: string,
  consumeRecord: (record: T, index: number) => void,
  checkpoint?: () => void
): Promise<NdjsonScanResult> {
  if (!(await pathExists(filePath))) {
    try {
      // A dangling symlink is existing evidence, not an absent log.
      await lstat(filePath);
    } catch (error) {
      if (isRecord(error) && (error.code === "ENOENT" || error.code === "ENOTDIR")) {
        return { recordCount: 0, discardedLines: 0, warnings: [] };
      }
      throw error;
    }
  }

  return withStableCaptureFile(filePath, (input) =>
    scanOpenedNdjsonRecords(input, guard, label, consumeRecord, checkpoint)
  );
}

async function scanOpenedNdjsonRecords<T>(
  input: ReadStream,
  guard: (value: unknown) => value is T,
  label: string,
  consumeRecord: (record: T, index: number) => void,
  checkpoint?: () => void
): Promise<NdjsonScanResult> {
  let recordCount = 0;
  const warnings: string[] = [];
  let discardedLines = 0;
  let lineNumber = 0;
  let warningOverflowRecorded = false;
  let lineParts: Buffer[] = [];
  let lineLength = 0;
  let discardingOversizedLine = false;

  const addWarning = (warning: string): void => {
    if (warnings.length < MAX_INTEGRITY_WARNINGS) {
      warnings.push(warning);
    } else if (!warningOverflowRecorded) {
      warnings.push(`Additional malformed ${label} warnings were omitted.`);
      warningOverflowRecorded = true;
    }
  };

  const processLine = (line: Buffer, oversized: boolean): void => {
    lineNumber += 1;
    const normalized = line.length > 0 && line[line.length - 1] === 13 ? line.subarray(0, -1) : line;
    if (oversized) {
      discardedLines += 1;
      addWarning(`Discarded oversized ${label} on line ${lineNumber}.`);
      return;
    }

    if (normalized.length === 0) {
      return;
    }

    if (recordCount >= MAX_NDJSON_RECORDS) {
      discardedLines += 1;
      addWarning(`Discarded ${label} beyond the ${MAX_NDJSON_RECORDS} record limit.`);
      return;
    }

    checkpoint?.();
    let record: T;
    try {
      const parsed = JSON.parse(normalized.toString("utf8")) as unknown;
      if (!guard(parsed)) {
        discardedLines += 1;
        addWarning(`Discarded malformed ${label} on line ${lineNumber}.`);
        return;
      }
      record = parsed;
    } catch {
      discardedLines += 1;
      addWarning(`Discarded unreadable ${label} on line ${lineNumber}.`);
      return;
    }
    consumeRecord(record, recordCount);
    recordCount += 1;
  };

  for await (const chunk of input) {
    checkpoint?.();
    let offset = 0;
    while (offset < chunk.length) {
      const newline = chunk.indexOf(10, offset);
      const segmentEnd = newline === -1 ? chunk.length : newline;
      const segment = chunk.subarray(offset, segmentEnd);

      if (!discardingOversizedLine) {
        if (lineLength + segment.length > MAX_NDJSON_LINE_BYTES) {
          lineParts = [];
          lineLength = 0;
          discardingOversizedLine = true;
        } else if (segment.length > 0) {
          lineParts.push(segment);
          lineLength += segment.length;
        }
      }

      if (newline === -1) {
        break;
      }

      processLine(
        discardingOversizedLine ? Buffer.alloc(0) : Buffer.concat(lineParts, lineLength),
        discardingOversizedLine
      );
      lineParts = [];
      lineLength = 0;
      discardingOversizedLine = false;
      offset = newline + 1;
    }
  }

  if (discardingOversizedLine || lineLength > 0) {
    processLine(
      discardingOversizedLine ? Buffer.alloc(0) : Buffer.concat(lineParts, lineLength),
      discardingOversizedLine
    );
  }

  return { recordCount, discardedLines, warnings };
}

async function withStableCaptureFile<T>(filePath: string, read: (input: ReadStream) => Promise<T>): Promise<T> {
  const observed = await lstat(filePath, { bigint: true });
  if (!observed.isFile()) throw new Error(`${path.basename(filePath)} is not a regular capture log.`);
  // POSIX refuses links and avoids blocking if a regular file is replaced by a FIFO before open.
  const flags =
    process.platform === "win32"
      ? constants.O_RDONLY
      : constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
  const handle = await open(filePath, flags);
  let input: ReadStream | undefined;
  let result: T | undefined;
  let failed = false;
  let failure: unknown;
  try {
    const opened = await handle.stat({ bigint: true });
    if (!sameCaptureFile(observed, opened)) throw new Error(`${path.basename(filePath)} changed during capture read.`);
    if (opened.size > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Capture log exceeds the supported read size.");
    // One extra byte detects growth; a continuously appended log cannot keep the reader alive.
    input = handle.createReadStream({
      highWaterMark: NDJSON_READ_CHUNK_BYTES,
      autoClose: false,
      end: Number(opened.size),
    });
    result = await read(input);
    const finished = await handle.stat({ bigint: true });
    const current = await lstat(filePath, { bigint: true });
    if (
      input.bytesRead !== Number(opened.size) ||
      !sameCaptureFile(opened, finished) ||
      !sameCaptureFile(finished, current)
    ) {
      throw new Error(`${path.basename(filePath)} changed during capture read.`);
    }
  } catch (error) {
    failed = true;
    failure = error;
  }
  input?.destroy();
  try {
    await handle.close();
  } catch (closeFailure) {
    if (failed)
      throw new AggregateError([failure, closeFailure], "Capture read and descriptor close both failed.", {
        cause: closeFailure,
      });
    throw closeFailure;
  }
  if (failed) throw failure;
  return result as T;
}

function sameCaptureFile(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.isFile() &&
    right.isFile() &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function isIsoDate(value: unknown): value is string {
  return typeof value === "string" && value.length <= 40 && !Number.isNaN(Date.parse(value));
}

function isBoundedString(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength;
}

function isOptionalBoundedString(value: unknown, maxLength: number): value is string | undefined {
  return value === undefined || isBoundedString(value, maxLength);
}
