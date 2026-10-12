import { createHash } from "node:crypto";
import { lstat, open } from "node:fs/promises";
import path from "node:path";
import type { SessionReport } from "../types.js";
import { readFileLimited } from "../utils/files.js";
import { isCapturedCommandEvent, isCapturedFileEvent } from "./ndjson.js";

export const INLINE_REPORT_BYTES = 32 * 1024 * 1024;
export const MAX_REPORT_BYTES = 256 * 1024 * 1024;
export const REPORT_REPLAY_FILE = "session-replay.json";
export const FILE_DIGEST_STREAM_BYTES = 64 * 1024;
const MAX_MATERIALIZED_BYTES = 4096 * 1024 * 1024;
const MAX_REPORT_JSON_DEPTH = 1024;

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

/** Preflight a JSON quota and also bound the actual read if the file grows after inspection. */
export async function readJsonFileWithinBudget<T>(
  filePath: string,
  formatLimitBytes: number,
  maxMaterializedBytes?: number
): Promise<T> {
  const bytes = await readBufferWithinBudget(filePath, formatLimitBytes, maxMaterializedBytes);
  return JSON.parse(bytes.toString("utf8")) as T;
}

export async function readBufferWithinBudget(
  filePath: string,
  formatLimitBytes: number,
  maxMaterializedBytes?: number
): Promise<Buffer> {
  validateMaterializationLimit(maxMaterializedBytes);
  if (!Number.isSafeInteger(formatLimitBytes) || formatLimitBytes < 0) {
    throw new Error("File size limit must be a non-negative safe integer.");
  }
  if (maxMaterializedBytes === undefined) {
    return readFileLimited(filePath, formatLimitBytes);
  }
  const details = await lstat(filePath);
  if (!details.isFile()) {
    throw new Error(`${path.basename(filePath)} is not a regular file.`);
  }
  if (details.size > formatLimitBytes) {
    throw jsonSizeLimitError(filePath, formatLimitBytes);
  }
  assertMaterializationBudget(filePath, details.size, maxMaterializedBytes);
  const readLimit = Math.min(formatLimitBytes, maxMaterializedBytes);
  try {
    return await readFileLimited(filePath, readLimit);
  } catch (error) {
    const limitLabel = readLimit % (1024 * 1024) === 0 ? `${readLimit / 1024 / 1024} MiB` : `${readLimit} bytes`;
    if (
      maxMaterializedBytes < formatLimitBytes &&
      error instanceof Error &&
      error.message === `${path.basename(filePath)} exceeds the ${limitLabel} size limit.`
    ) {
      // Keep quota failures distinct from corruption when a regular file grew during the bounded read.
      const current = await lstat(filePath).catch(() => undefined);
      if (current?.isFile()) {
        if (current.size > formatLimitBytes) {
          throw jsonSizeLimitError(filePath, formatLimitBytes);
        }
        if (current.size > maxMaterializedBytes) {
          throw new MaterializationBudgetError(filePath, current.size, maxMaterializedBytes);
        }
      }
    }
    throw error;
  }
}

function jsonSizeLimitError(filePath: string, maxBytes: number): Error {
  const label = maxBytes % (1024 * 1024) === 0 ? `${maxBytes / 1024 / 1024} MiB` : `${maxBytes} bytes`;
  return new Error(`${path.basename(filePath)} exceeds the ${label} size limit.`);
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

export function digestBuffer(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export async function digestRegularFile(
  filePath: string,
  maxBytes?: number
): Promise<{ bytes: number; digest: string }> {
  if (maxBytes !== undefined && (!Number.isSafeInteger(maxBytes) || maxBytes < 0)) {
    throw new Error("Digest size limit must be a non-negative safe integer.");
  }
  return digestOpenedRegularFile(
    filePath,
    maxBytes,
    () => new Error(`${path.basename(filePath)} exceeds the ${maxBytes} byte digest size limit.`)
  );
}

/** Verify the original bytes while retaining only the report's non-record fields. */
export async function readCanonicalReportCore(
  filePath: string,
  maxMaterializedBytes?: number
): Promise<{
  bytes: number;
  digest: string;
  core: unknown;
  eventCount: number;
  commandCount: number;
  eventsDigest: string;
  commandsDigest: string;
}> {
  validateMaterializationLimit(maxMaterializedBytes);
  const parser = new ReportCoreParser(filePath, maxMaterializedBytes);
  const digest = await digestOpenedRegularFile(
    filePath,
    MAX_REPORT_BYTES,
    () => jsonSizeLimitError(filePath, MAX_REPORT_BYTES),
    (chunk) => parser.write(chunk)
  );
  return { ...digest, ...parser.finish() };
}

async function digestOpenedRegularFile(
  filePath: string,
  maxBytes: number | undefined,
  sizeError: () => Error,
  onChunk?: (chunk: Buffer) => void
): Promise<{ bytes: number; digest: string }> {
  // Windows file identities can exceed Number.MAX_SAFE_INTEGER; compare them without rounding.
  const details = await lstat(filePath, { bigint: true });
  if (!details.isFile()) {
    throw new Error(`${path.basename(filePath)} is not a regular file.`);
  }
  const handle = await open(filePath, "r");
  let failed = false;
  let readFailure: unknown;
  let bytes = 0;
  let digest = "";
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || opened.dev !== details.dev || opened.ino !== details.ino) {
      throw new Error(`${path.basename(filePath)} changed during verification.`);
    }
    if (maxBytes !== undefined && opened.size > BigInt(maxBytes)) {
      throw sizeError();
    }
    const openedSize = Number(opened.size);
    if (!Number.isSafeInteger(openedSize)) {
      throw new Error(`${path.basename(filePath)} exceeds the supported digest size limit.`);
    }
    const hash = createHash("sha256");
    const buffer = Buffer.alloc(FILE_DIGEST_STREAM_BYTES);
    while (true) {
      // Read at most the opened length plus one byte, so a growing file cannot keep verification alive.
      const length = Math.min(buffer.length, openedSize - bytes + 1);
      const { bytesRead } = await handle.read(buffer, 0, length, null);
      if (bytesRead === 0) {
        break;
      }
      bytes += bytesRead;
      if (bytes > openedSize) {
        throw new Error(`${path.basename(filePath)} changed during verification.`);
      }
      const chunk = buffer.subarray(0, bytesRead);
      hash.update(chunk);
      onChunk?.(chunk);
    }
    const finished = await handle.stat({ bigint: true });
    const current = await lstat(filePath, { bigint: true });
    if (
      bytes !== openedSize ||
      finished.size !== opened.size ||
      finished.mtimeNs !== opened.mtimeNs ||
      finished.ctimeNs !== opened.ctimeNs ||
      !current.isFile() ||
      current.dev !== opened.dev ||
      current.ino !== opened.ino ||
      current.size !== finished.size ||
      current.mtimeNs !== finished.mtimeNs ||
      current.ctimeNs !== finished.ctimeNs
    ) {
      throw new Error(`${path.basename(filePath)} changed during verification.`);
    }
    digest = hash.digest("hex");
  } catch (error) {
    failed = true;
    readFailure = error;
  }
  try {
    await handle.close();
  } catch (closeFailure) {
    if (failed) {
      throw new AggregateError([readFailure, closeFailure], "File verification and descriptor close both failed.", {
        cause: closeFailure,
      });
    }
    throw closeFailure;
  }
  if (failed) {
    throw readFailure;
  }
  return { bytes, digest };
}

type JsonFrame = {
  kind: "object" | "array";
  state: "key-or-end" | "key" | "colon" | "value" | "value-or-end" | "comma-or-end";
};

/** Streaming JSON grammar validation keeps even discarded arrays subject to the JSON contract. */
class ReportCoreParser {
  private readonly chunks: Buffer[] = [];
  private readonly frames: JsonFrame[] = [];
  private readonly topLevelKeys = new Set<string>();
  private retainedBytes = 0;
  private done = false;
  private token: "string" | "number" | "literal" | undefined;
  private stringIsKey = false;
  private keyText = "";
  private property = "";
  private escaped = false;
  private unicodeRemaining = 0;
  private numberState = "";
  private literal = "";
  private literalOffset = 0;
  private skippedDepth: number | undefined;
  private readonly recordChunks: Buffer[] = [];
  private recordBytes = 0;
  private recordActive = false;
  private readonly eventsHash = createHash("sha256").update("[");
  private readonly commandsHash = createHash("sha256").update("[");
  private eventCount = 0;
  private commandCount = 0;

  constructor(
    private readonly filePath: string,
    private readonly maxMaterializedBytes?: number
  ) {}

  write(chunk: Buffer): void {
    // Scan ordinary string runs natively; record excerpts can span thousands of bytes.
    // eslint-disable-next-line no-control-regex -- JSON strings must stop at quotes, escapes, or invalid controls.
    const stringBoundary = /["\\\x00-\x1f]/g;
    const text = chunk.toString("latin1");
    let retainedStart = this.skippedDepth === undefined ? 0 : -1;
    let recordStart = this.recordActive ? 0 : -1;
    for (let offset = 0; offset < chunk.length; offset += 1) {
      if (this.token === "string" && !this.escaped && this.unicodeRemaining === 0) {
        stringBoundary.lastIndex = offset;
        const boundary = stringBoundary.exec(text)?.index ?? chunk.length;
        if (boundary > offset) {
          if (this.stringIsKey && this.frames.length === 1) {
            this.retainKeyText(text.slice(offset, boundary));
          }
          offset = boundary - 1;
          continue;
        }
      }
      const wasSkipped = this.skippedDepth !== undefined;
      const wasRecording = this.recordActive;
      this.consume(chunk[offset]!);
      const isSkipped = this.skippedDepth !== undefined;
      if (!wasSkipped && isSkipped) {
        this.retain(chunk.subarray(retainedStart, offset));
        this.retain(Buffer.from("[]"));
        retainedStart = -1;
      } else if (wasSkipped && !isSkipped) {
        retainedStart = offset + 1;
      }
      if (!wasRecording && this.recordActive) {
        recordStart = offset;
      } else if (wasRecording && !this.recordActive) {
        this.retainRecord(chunk.subarray(recordStart, offset + 1));
        this.finishRecord();
        recordStart = -1;
      }
      // A hostile discarded record must not create an unbounded parser stack.
      if (this.frames.length > MAX_REPORT_JSON_DEPTH) {
        throw new Error(
          `${path.basename(this.filePath)} exceeds the ${MAX_REPORT_JSON_DEPTH} level JSON nesting limit.`
        );
      }
    }
    if (retainedStart >= 0) {
      this.retain(chunk.subarray(retainedStart));
    }
    if (recordStart >= 0) {
      this.retainRecord(chunk.subarray(recordStart));
    }
  }

  finish(): {
    core: unknown;
    eventCount: number;
    commandCount: number;
    eventsDigest: string;
    commandsDigest: string;
  } {
    if (this.token === "number" || this.token === "literal") {
      this.finishPrimitive();
    }
    if (this.token || this.frames.length > 0 || !this.done) {
      this.invalid();
    }
    return {
      core: JSON.parse(Buffer.concat(this.chunks, this.retainedBytes).toString("utf8")) as unknown,
      eventCount: this.eventCount,
      commandCount: this.commandCount,
      eventsDigest: this.eventsHash.update("]").digest("hex"),
      commandsDigest: this.commandsHash.update("]").digest("hex"),
    };
  }

  private retain(bytes: Buffer): void {
    if (bytes.length === 0) return;
    this.retainedBytes += bytes.length;
    if (this.retainedBytes > INLINE_REPORT_BYTES) {
      throw jsonSizeLimitError(this.filePath, INLINE_REPORT_BYTES);
    }
    this.assertWorkingInputBudget();
    this.chunks.push(Buffer.from(bytes));
  }

  private retainRecord(bytes: Buffer): void {
    this.recordBytes += bytes.length;
    if (this.recordBytes > INLINE_REPORT_BYTES) {
      throw new Error(`${path.basename(this.filePath)} contains a record exceeding the 32 MiB encoded record limit.`);
    }
    this.assertWorkingInputBudget();
    this.recordChunks.push(Buffer.from(bytes));
  }

  private assertWorkingInputBudget(): void {
    const bytes = this.retainedBytes + this.recordBytes;
    assertMaterializationBudget(this.filePath, bytes, this.maxMaterializedBytes);
  }

  private finishRecord(): void {
    const record: unknown = JSON.parse(Buffer.concat(this.recordChunks, this.recordBytes).toString("utf8"));
    const fileEvent = this.property === "events";
    if (!(fileEvent ? isCapturedFileEvent(record) : isCapturedCommandEvent(record))) {
      throw new Error(
        `${path.basename(this.filePath)} contains an invalid ${fileEvent ? "file event" : "command event"}.`
      );
    }
    const count = fileEvent ? this.eventCount : this.commandCount;
    const hash = fileEvent ? this.eventsHash : this.commandsHash;
    if (count > 0) hash.update(",");
    hash.update(JSON.stringify(record));
    if (fileEvent) this.eventCount += 1;
    else this.commandCount += 1;
    this.recordChunks.length = 0;
    this.recordBytes = 0;
  }

  private consume(byte: number): void {
    if (this.token === "string") {
      this.consumeString(byte);
      return;
    }
    if (this.token === "number" || this.token === "literal") {
      if (byte === 32 || byte === 9 || byte === 10 || byte === 13 || byte === 44 || byte === 93 || byte === 125) {
        this.finishPrimitive();
      } else {
        this.consumePrimitive(byte);
        return;
      }
    }
    if (byte === 32 || byte === 9 || byte === 10 || byte === 13) return;
    const frame = this.frames.at(-1);
    if (!frame) {
      if (this.done || byte !== 123) this.invalid();
      this.frames.push({ kind: "object", state: "key-or-end" });
      return;
    }
    if (frame.state === "key" || frame.state === "key-or-end") {
      if (frame.state === "key-or-end" && byte === 125) {
        this.closeFrame();
      } else if (byte === 34) {
        this.token = "string";
        this.stringIsKey = true;
        this.keyText = this.frames.length === 1 ? '"' : "";
      } else this.invalid();
      return;
    }
    if (frame.state === "colon") {
      if (byte !== 58) this.invalid();
      frame.state = "value";
      return;
    }
    if (frame.state === "comma-or-end") {
      if (byte === 44) frame.state = frame.kind === "object" ? "key" : "value";
      else if (byte === (frame.kind === "object" ? 125 : 93)) this.closeFrame();
      else this.invalid();
      return;
    }
    if (frame.state === "value-or-end" && byte === 93) {
      this.closeFrame();
      return;
    }
    if (this.skippedDepth === this.frames.length) {
      if (byte !== 123) this.invalid();
      this.recordActive = true;
    }
    if (this.frames.length === 1 && (this.property === "events" || this.property === "commands")) {
      if (byte !== 91) this.invalid();
      this.skippedDepth = 2;
    }
    frame.state = "comma-or-end";
    if (byte === 123 || byte === 91) {
      this.frames.push({
        kind: byte === 123 ? "object" : "array",
        state: byte === 123 ? "key-or-end" : "value-or-end",
      });
    } else if (byte === 34) {
      this.token = "string";
      this.stringIsKey = false;
    } else if (byte === 45 || (byte >= 48 && byte <= 57)) {
      this.token = "number";
      this.numberState = byte === 45 ? "minus" : byte === 48 ? "zero" : "integer";
    } else if (byte === 116 || byte === 102 || byte === 110) {
      this.token = "literal";
      this.literal = byte === 116 ? "true" : byte === 102 ? "false" : "null";
      this.literalOffset = 1;
    } else this.invalid();
  }

  private consumeString(byte: number): void {
    if (this.stringIsKey && this.frames.length === 1) {
      this.retainKeyText(String.fromCharCode(byte));
    }
    if (this.unicodeRemaining > 0) {
      if (!((byte >= 48 && byte <= 57) || (byte >= 65 && byte <= 70) || (byte >= 97 && byte <= 102))) this.invalid();
      this.unicodeRemaining -= 1;
    } else if (this.escaped) {
      this.escaped = false;
      if (byte === 117) this.unicodeRemaining = 4;
      else if (![34, 47, 92, 98, 102, 110, 114, 116].includes(byte)) this.invalid();
    } else if (byte === 92) this.escaped = true;
    else if (byte === 34) {
      this.token = undefined;
      if (this.stringIsKey) {
        this.frames.at(-1)!.state = "colon";
        if (this.frames.length === 1) {
          this.property = JSON.parse(Buffer.from(this.keyText, "latin1").toString("utf8")) as string;
          if (this.topLevelKeys.has(this.property)) this.invalid();
          this.topLevelKeys.add(this.property);
          this.keyText = "";
        }
      }
    } else if (byte < 32) this.invalid();
  }

  private retainKeyText(text: string): void {
    this.keyText += text;
    if (this.keyText.length > INLINE_REPORT_BYTES) {
      throw jsonSizeLimitError(this.filePath, INLINE_REPORT_BYTES);
    }
    assertMaterializationBudget(this.filePath, this.keyText.length, this.maxMaterializedBytes);
  }

  private consumePrimitive(byte: number): void {
    if (this.token === "literal") {
      if (byte !== this.literal.charCodeAt(this.literalOffset)) this.invalid();
      this.literalOffset += 1;
      return;
    }
    const digit = byte >= 48 && byte <= 57;
    switch (this.numberState) {
      case "minus":
        if (!digit) this.invalid();
        this.numberState = byte === 48 ? "zero" : "integer";
        break;
      case "zero":
      case "integer":
      case "fraction":
        if (digit && this.numberState !== "zero") break;
        if (byte === 46 && (this.numberState === "zero" || this.numberState === "integer"))
          this.numberState = "fraction-start";
        else if (byte === 101 || byte === 69) this.numberState = "exponent-start";
        else this.invalid();
        break;
      case "fraction-start":
        if (!digit) this.invalid();
        this.numberState = "fraction";
        break;
      case "exponent-start":
        if (byte === 43 || byte === 45) this.numberState = "exponent-sign";
        else if (digit) this.numberState = "exponent";
        else this.invalid();
        break;
      case "exponent-sign":
      case "exponent":
        if (!digit) this.invalid();
        this.numberState = "exponent";
        break;
    }
  }

  private finishPrimitive(): void {
    if (
      (this.token === "literal" && this.literalOffset !== this.literal.length) ||
      (this.token === "number" && !["zero", "integer", "fraction", "exponent"].includes(this.numberState))
    )
      this.invalid();
    this.token = undefined;
  }

  private closeFrame(): void {
    if (this.recordActive && this.frames.length === 3) this.recordActive = false;
    if (this.skippedDepth === this.frames.length) this.skippedDepth = undefined;
    this.frames.pop();
    if (this.frames.length === 0) this.done = true;
  }

  private invalid(): never {
    throw new SyntaxError(`${path.basename(this.filePath)} contains invalid or ambiguous report JSON.`);
  }
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
