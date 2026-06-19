import { open, stat } from "node:fs/promises";
import type { FileKind } from "../types.js";

const DEFAULT_SAMPLE_BYTES = 64 * 1024;

export interface FileInspection {
  kind: FileKind;
  sizeBytes?: number;
  text?: string;
  reason?: string;
}

export async function inspectTextFile(
  absolutePath: string,
  maxTextBytes: number,
  sampleBytes = DEFAULT_SAMPLE_BYTES
): Promise<FileInspection> {
  let stats;
  try {
    stats = await stat(absolutePath);
  } catch {
    return { kind: "missing", reason: "File does not exist." };
  }

  if (!stats.isFile()) {
    return { kind: "not-file", sizeBytes: stats.size, reason: "Path is not a regular file." };
  }

  if (stats.size > maxTextBytes) {
    const sample = await readFilePrefix(absolutePath, Math.min(sampleBytes, stats.size));
    return {
      kind: isLikelyBinary(sample) ? "binary" : "large",
      sizeBytes: stats.size,
      reason: `File is larger than ${maxTextBytes} bytes.`
    };
  }

  const buffer = await readFilePrefix(absolutePath, stats.size);
  if (isLikelyBinary(buffer)) {
    return { kind: "binary", sizeBytes: stats.size, reason: "Binary-like byte patterns detected." };
  }

  return {
    kind: "text",
    sizeBytes: stats.size,
    text: buffer.toString("utf8")
  };
}

export function isLikelyBinary(buffer: Buffer): boolean {
  if (buffer.length === 0) {
    return false;
  }

  if (buffer.includes(0)) {
    return true;
  }

  let suspiciousBytes = 0;
  for (const byte of buffer) {
    const isAllowedControl = byte === 7 || byte === 8 || byte === 9 || byte === 10 || byte === 12 || byte === 13 || byte === 27;
    if (byte < 32 && !isAllowedControl) {
      suspiciousBytes += 1;
    }
  }

  const suspiciousRatio = suspiciousBytes / buffer.length;
  const decoded = buffer.toString("utf8");
  const replacementRatio = countReplacementCharacters(decoded) / Math.max(decoded.length, 1);

  return suspiciousRatio > 0.01 || replacementRatio > 0.01;
}

async function readFilePrefix(absolutePath: string, bytes: number): Promise<Buffer> {
  const handle = await open(absolutePath, "r");
  try {
    const buffer = Buffer.alloc(bytes);
    const result = await handle.read(buffer, 0, bytes, 0);
    return buffer.subarray(0, result.bytesRead);
  } finally {
    await handle.close();
  }
}

function countReplacementCharacters(value: string): number {
  let count = 0;
  for (const char of value) {
    if (char === "\uFFFD") {
      count += 1;
    }
  }

  return count;
}
