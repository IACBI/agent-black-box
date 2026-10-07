import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat } from "node:fs/promises";
import path from "node:path";
import type { SessionReport } from "../types.js";

export const INLINE_REPORT_BYTES = 32 * 1024 * 1024;
export const MAX_REPORT_BYTES = 256 * 1024 * 1024;
export const REPORT_REPLAY_FILE = "session-replay.json";
export const FILE_DIGEST_STREAM_BYTES = 64 * 1024;
const MAX_MATERIALIZED_BYTES = 4096 * 1024 * 1024;

export class MaterializationBudgetError extends Error {
  constructor(filePath: string, fileBytes: number, maxBytes: number) {
    super(
      `${path.basename(filePath)} requires ${fileBytes} materialized input bytes; the working-data policy allows ${maxBytes} bytes. Increase --memory-budget-mb or reduce --concurrency to inspect this session.`
    );
    this.name = "MaterializationBudgetError";
  }
}

export function validateMaterializationLimit(maxBytes: number | undefined): void {
  if (
    maxBytes !== undefined &&
    (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_MATERIALIZED_BYTES)
  ) {
    throw new Error("maxMaterializedBytes must be an integer between 1 and 4294967296 bytes.");
  }
}

export function assertMaterializationBudget(filePath: string, fileBytes: number, maxBytes: number | undefined): void {
  if (maxBytes !== undefined && fileBytes > maxBytes) {
    throw new MaterializationBudgetError(filePath, fileBytes, maxBytes);
  }
}

export interface ReportReplay {
  replayVersion: 1;
  id: string;
  reportBytes: number;
  reportDigest: string;
  eventCount: number;
  commandCount: number;
  eventsDigest: string;
  commandsDigest: string;
  eventLogBytes: number;
  commandLogBytes: number;
  report: SessionReport;
}

export function digestRecords(records: readonly unknown[]): string {
  const hash = createHash("sha256");
  hash.update("[");
  records.forEach((record, index) => {
    if (index > 0) {
      hash.update(",");
    }
    hash.update(JSON.stringify(record));
  });
  hash.update("]");
  return hash.digest("hex");
}

export function digestText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export async function digestRegularFile(filePath: string): Promise<{ bytes: number; digest: string }> {
  const details = await lstat(filePath);
  if (!details.isFile()) {
    throw new Error(`${path.basename(filePath)} is not a regular file.`);
  }

  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(filePath, { highWaterMark: FILE_DIGEST_STREAM_BYTES })) {
    hash.update(chunk);
    bytes += chunk.length;
  }
  if (bytes !== details.size) {
    throw new Error(`${path.basename(filePath)} changed during verification.`);
  }
  return { bytes, digest: hash.digest("hex") };
}

export function isReportReplay(value: unknown): value is ReportReplay {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  const isDigest = (item: unknown): item is string => typeof item === "string" && /^[0-9a-f]{64}$/.test(item);
  const isCount = (item: unknown): item is number => Number.isSafeInteger(item) && Number(item) >= 0;
  return (
    record.replayVersion === 1 &&
    typeof record.id === "string" &&
    isCount(record.reportBytes) &&
    record.reportBytes > INLINE_REPORT_BYTES &&
    record.reportBytes <= MAX_REPORT_BYTES &&
    isDigest(record.reportDigest) &&
    isCount(record.eventCount) &&
    isCount(record.commandCount) &&
    isDigest(record.eventsDigest) &&
    isDigest(record.commandsDigest) &&
    isCount(record.eventLogBytes) &&
    isCount(record.commandLogBytes) &&
    typeof record.report === "object" &&
    record.report !== null &&
    !Array.isArray(record.report)
  );
}
