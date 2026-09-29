import { lstat, open, realpath, type FileHandle } from "node:fs/promises";
import path from "node:path";
import type { FileKind } from "../types.js";
import { isPathInside } from "./paths.js";

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
  sampleBytes = DEFAULT_SAMPLE_BYTES,
  trustedRoot?: string
): Promise<FileInspection> {
  if (
    !Number.isSafeInteger(maxTextBytes) ||
    maxTextBytes < 0 ||
    !Number.isSafeInteger(sampleBytes) ||
    sampleBytes < 0
  ) {
    throw new Error("File inspection limits must be non-negative safe integers.");
  }
  let stats;
  try {
    stats = await lstat(absolutePath);
  } catch (error) {
    if (isNotFound(error)) {
      return { kind: "missing", reason: "File does not exist." };
    }
    throw error;
  }

  if (stats.isSymbolicLink() || !stats.isFile()) {
    return { kind: "not-file", sizeBytes: stats.size, reason: "Path is not a regular file." };
  }

  let handle: FileHandle;
  try {
    if (trustedRoot) {
      const [physicalRoot, physicalParent] = await Promise.all([
        realpath(trustedRoot),
        realpath(path.dirname(absolutePath)),
      ]);
      if (!isPathInside(physicalRoot, physicalParent)) {
        return { kind: "not-file", sizeBytes: stats.size, reason: "Path resolves outside the repository." };
      }
    }

    handle = await open(absolutePath, "r");
  } catch (error) {
    if (isNotFound(error)) {
      return { kind: "missing", reason: "File does not exist." };
    }
    throw error;
  }

  try {
    const opened = await handle.stat();
    if (
      !opened.isFile() ||
      opened.dev !== stats.dev ||
      opened.ino !== stats.ino ||
      opened.size !== stats.size ||
      opened.mtimeMs !== stats.mtimeMs
    ) {
      return { kind: "not-file", sizeBytes: opened.size, reason: "Path changed during inspection." };
    }

    if (opened.size > maxTextBytes) {
      const sample = await readFilePrefix(handle, Math.min(sampleBytes, opened.size));
      return {
        kind: isLikelyBinary(sample) ? "binary" : "large",
        sizeBytes: opened.size,
        reason: `File is larger than ${maxTextBytes} bytes.`,
      };
    }

    const buffer = await readFilePrefix(handle, opened.size);
    const completed = await handle.stat();
    if (buffer.length !== opened.size || completed.size !== opened.size || completed.mtimeMs !== opened.mtimeMs) {
      return { kind: "unknown", sizeBytes: completed.size, reason: "File changed during inspection." };
    }
    if (isLikelyBinary(buffer)) {
      return { kind: "binary", sizeBytes: opened.size, reason: "Binary-like byte patterns detected." };
    }

    return {
      kind: "text",
      sizeBytes: opened.size,
      text: buffer.toString("utf8"),
    };
  } finally {
    await handle.close();
  }
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
    const isAllowedControl =
      byte === 7 || byte === 8 || byte === 9 || byte === 10 || byte === 12 || byte === 13 || byte === 27;
    if (byte < 32 && !isAllowedControl) {
      suspiciousBytes += 1;
    }
  }

  const suspiciousRatio = suspiciousBytes / buffer.length;
  const decoded = buffer.toString("utf8");
  const replacementRatio = countReplacementCharacters(decoded) / Math.max(decoded.length, 1);

  return suspiciousRatio > 0.01 || replacementRatio > 0.01;
}

async function readFilePrefix(handle: FileHandle, bytes: number): Promise<Buffer> {
  const buffer = Buffer.alloc(bytes);
  let offset = 0;
  while (offset < bytes) {
    const { bytesRead } = await handle.read(buffer, offset, bytes - offset, offset);
    if (bytesRead === 0) {
      break;
    }
    offset += bytesRead;
  }
  return buffer.subarray(0, offset);
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
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
