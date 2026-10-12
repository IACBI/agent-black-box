import { randomUUID } from "node:crypto";
import { access, link, mkdir, open, rename, rm } from "node:fs/promises";
import path from "node:path";
import { isRecord } from "./records.js";

export async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch (error) {
    if (isRecord(error) && (error.code === "ENOENT" || error.code === "ENOTDIR")) {
      return false;
    }
    throw error;
  }
}

export async function ensureDir(dirPath: string): Promise<void> {
  await mkdir(dirPath, { recursive: true });
}

export async function readJsonFileLimited<T>(filePath: string, maxBytes: number): Promise<T> {
  const raw = await readTextFileLimited(filePath, maxBytes);
  return JSON.parse(raw) as T;
}

export async function readTextFileLimited(filePath: string, maxBytes: number): Promise<string> {
  return (await readFileLimited(filePath, maxBytes)).toString("utf8");
}

export async function readFileLimited(filePath: string, maxBytes: number): Promise<Buffer> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new Error("File size limit must be a non-negative safe integer.");
  }

  const sizeError = () => new Error(`${path.basename(filePath)} exceeds the ${formatByteLimit(maxBytes)} size limit.`);
  const handle = await open(filePath, "r");
  try {
    const details = await handle.stat();
    if (!details.isFile()) {
      throw new Error(`${path.basename(filePath)} is not a regular file.`);
    }
    if (details.size > maxBytes) {
      throw sizeError();
    }

    // Bound the reads themselves: the file can grow after stat().
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    while (true) {
      const buffer = Buffer.alloc(Math.min(64 * 1024, maxBytes - totalBytes + 1));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) {
        return Buffer.concat(chunks, totalBytes);
      }
      totalBytes += bytesRead;
      if (totalBytes > maxBytes) {
        throw sizeError();
      }
      chunks.push(buffer.subarray(0, bytesRead));
    }
  } finally {
    await handle.close();
  }
}

export async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
  await writeTextFileAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

export async function writeTextFileAtomic(
  filePath: string,
  contents: string,
  options: { overwrite?: boolean } = {}
): Promise<void> {
  const directory = path.dirname(filePath);
  await ensureDir(directory);

  const temporaryPath = path.join(directory, `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
  const handle = await open(temporaryPath, "wx", 0o600);
  const failures: unknown[] = [];
  try {
    await handle.writeFile(contents, "utf8");
    await handle.sync();
  } catch (error) {
    failures.push(error);
  }
  try {
    await handle.close();
  } catch (error) {
    failures.push(error);
  }

  if (failures.length === 0) {
    try {
      if (options.overwrite === false) {
        // Publish the completed file exclusively; rename would overwrite a concurrent creator.
        await link(temporaryPath, filePath);
      } else {
        await rename(temporaryPath, filePath);
      }
    } catch (error) {
      failures.push(error);
    }
  }
  // Close and cleanup failures must not hide the original write/publication failure.
  if (options.overwrite === false || failures.length > 0) {
    try {
      await rm(temporaryPath, { force: true });
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length === 1) {
    throw failures[0];
  }
  if (failures.length > 1) {
    throw new AggregateError(failures, "Atomic file publication failed; additional close or cleanup errors occurred.");
  }
}

export async function removeFileIfExists(filePath: string): Promise<void> {
  await rm(filePath, { force: true });
}

function formatByteLimit(maxBytes: number): string {
  if (maxBytes % (1024 * 1024) === 0) {
    return `${maxBytes / (1024 * 1024)} MiB`;
  }
  return `${maxBytes} bytes`;
}
