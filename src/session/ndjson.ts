import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import type { CommandEvent, FileEvent } from "../types.js";
import { pathExists } from "../utils/files.js";

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
  label: string
): Promise<NdjsonReadResult<T>> {
  const records: T[] = [];
  const result = await scanNdjsonRecords(filePath, guard, label, (record) => records.push(record));
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
  consumeRecord: (record: T, index: number) => void
): Promise<NdjsonScanResult> {
  if (!(await pathExists(filePath))) {
    return { recordCount: 0, discardedLines: 0, warnings: [] };
  }

  let recordCount = 0;
  const warnings: string[] = [];
  let discardedLines = 0;
  let lineNumber = 0;
  let warningOverflowRecorded = false;
  const input = createReadStream(filePath, { highWaterMark: NDJSON_READ_CHUNK_BYTES });
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
