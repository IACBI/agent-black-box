import { spawn } from "node:child_process";
import { gitExecutable, gitProcessEnvironment } from "./executable.js";

const OBJECT_ID = /^[0-9a-f]{40,64}$/;
const HEADER = /^([0-9a-f]{40,64}) (\S+) (\d+)$/;
const MAX_HEADER_BYTES = 512;
const LINE_FEED = 0x0a;
const FAILURE_MESSAGE = "Could not read a staged Git blob.";

/**
 * Checks sizes before reading blobs with `git cat-file --batch`. The result lines up
 * with `objectIds`; an entry is `null` when that blob is larger than `maxBytes` (its content is never
 * buffered). A missing object, a non-blob object, or any Git failure rejects, as `git cat-file blob` would.
 */
export function readGitBlobs(
  repoRoot: string,
  objectIds: readonly string[],
  maxBytes: number
): Promise<Array<Buffer | null>>;
/** Transforms each bounded blob as it arrives, avoiding retention of the whole raw input batch. */
export function readGitBlobs<T>(
  repoRoot: string,
  objectIds: readonly string[],
  maxBytes: number,
  transform: (blob: Buffer | null, index: number) => T
): Promise<T[]>;
export async function readGitBlobs<T>(
  repoRoot: string,
  objectIds: readonly string[],
  maxBytes: number,
  transform?: (blob: Buffer | null, index: number) => T
): Promise<Array<T | Buffer | null>> {
  if (!objectIds.every((objectId) => OBJECT_ID.test(objectId))) {
    throw new Error("Blob identifiers must be full Git object IDs.");
  }
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new Error("Blob size limits must be non-negative safe integers.");
  }
  if (objectIds.length === 0) {
    return [];
  }

  const sizes = await readGitBlobSizes(repoRoot, objectIds);
  const positions = sizes.flatMap((size, index) => (size <= maxBytes ? [index] : []));
  const mapped: Array<T | Buffer | null> = new Array(objectIds.length);
  // Consume in original order, including oversized entries, so quota admissions remain deterministic.
  let nextPosition = 0;
  const consume = (blob: Buffer | null, position: number): void => {
    mapped[position] = transform ? transform(blob, position) : blob;
  };
  await readBoundedGitBlobs(
    repoRoot,
    positions.map((position) => objectIds[position]!),
    maxBytes,
    (blob, index) => {
      const position = positions[index]!;
      while (nextPosition < position) {
        consume(null, nextPosition++);
      }
      consume(blob, nextPosition++);
    }
  );
  while (nextPosition < objectIds.length) {
    consume(null, nextPosition++);
  }
  return mapped;
}

/** Metadata requests do not inflate or stream an oversized object's body. */
function readGitBlobSizes(repoRoot: string, objectIds: readonly string[]): Promise<number[]> {
  return new Promise((resolve, reject) => {
    const child = spawn(gitExecutable(), ["cat-file", "--batch-check"], {
      cwd: repoRoot,
      env: gitProcessEnvironment(),
      stdio: ["pipe", "pipe", "ignore"],
      windowsHide: true,
    });
    const sizes: number[] = [];
    let pending = "";
    let settled = false;
    const fail = (cause?: unknown): void => {
      if (!settled) {
        settled = true;
        child.kill();
        reject(new Error(FAILURE_MESSAGE, cause === undefined ? undefined : { cause }));
      }
    };
    child.stdout.on("data", (chunk: Buffer) => {
      if (settled) {
        return;
      }
      pending += chunk.toString("latin1");
      let lineFeed;
      while ((lineFeed = pending.indexOf("\n")) !== -1) {
        const header = pending.slice(0, lineFeed);
        pending = pending.slice(lineFeed + 1);
        const match = HEADER.exec(header);
        const size = Number(match?.[3]);
        if (
          header.length > MAX_HEADER_BYTES ||
          !match ||
          match[1] !== objectIds[sizes.length] ||
          match[2] !== "blob" ||
          !Number.isSafeInteger(size) ||
          size < 0
        ) {
          fail();
          return;
        }
        sizes.push(size);
      }
      if (pending.length > MAX_HEADER_BYTES) {
        fail();
      }
    });
    child.stdout.on("error", fail);
    child.stdin.on("error", () => undefined);
    child.once("error", fail);
    child.once("close", (code) => {
      if (!settled) {
        if (code !== 0 || pending.length !== 0 || sizes.length !== objectIds.length) {
          fail();
          return;
        }
        settled = true;
        resolve(sizes);
      }
    });
    child.stdin.end(`${objectIds.join("\n")}\n`);
  });
}

function readBoundedGitBlobs(
  repoRoot: string,
  objectIds: readonly string[],
  maxBytes: number,
  onBlob: (blob: Buffer | null, index: number) => void
): Promise<void> {
  if (objectIds.length === 0) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    const child = spawn(gitExecutable(), ["cat-file", "--batch"], {
      cwd: repoRoot,
      env: gitProcessEnvironment(),
      stdio: ["pipe", "pipe", "ignore"],
      windowsHide: true,
    });
    let resultCount = 0;
    let headerParts: Buffer[] = [];
    let headerLength = 0;
    // `remaining` counts the unread body bytes including the LF that terminates every batch record.
    let remaining = 0;
    let bodySize = 0;
    let bodyRead = 0;
    let body: Buffer[] | null = null;
    let settled = false;

    const fail = (cause?: unknown): void => {
      if (!settled) {
        settled = true;
        child.kill();
        reject(new Error(FAILURE_MESSAGE, cause === undefined ? undefined : { cause }));
      }
    };

    const startRecord = (header: string): void => {
      const match = HEADER.exec(header);
      if (
        !match ||
        match[1] !== objectIds[resultCount] ||
        match[2] !== "blob" ||
        !Number.isSafeInteger(Number(match[3]))
      ) {
        fail();
        return;
      }
      bodySize = Number(match[3]);
      bodyRead = 0;
      remaining = bodySize + 1;
      body = bodySize <= maxBytes ? [] : null;
    };

    const consume = (chunk: Buffer): void => {
      let offset = 0;
      while (offset < chunk.length && !settled) {
        if (remaining === 0) {
          const lineFeed = chunk.indexOf(LINE_FEED, offset);
          const end = lineFeed === -1 ? chunk.length : lineFeed;
          headerLength += end - offset;
          if (headerLength > MAX_HEADER_BYTES) {
            fail();
            return;
          }
          headerParts.push(chunk.subarray(offset, end));
          offset = lineFeed === -1 ? chunk.length : lineFeed + 1;
          if (lineFeed !== -1) {
            const header = Buffer.concat(headerParts).toString("latin1");
            headerParts = [];
            headerLength = 0;
            startRecord(header);
          }
          continue;
        }

        const take = Math.min(remaining, chunk.length - offset);
        const contentTake = Math.max(0, Math.min(take, bodySize - bodyRead));
        if (body !== null && contentTake > 0) {
          body.push(chunk.subarray(offset, offset + contentTake));
        }
        bodyRead += contentTake;
        remaining -= take;
        offset += take;
        if (remaining === 0) {
          try {
            onBlob(body === null ? null : Buffer.concat(body, bodySize), resultCount++);
          } catch (error) {
            fail(error);
            return;
          }
          body = null;
        }
      }
    };

    child.stdout.on("data", consume);
    child.stdout.on("error", fail);
    child.stdin.on("error", () => undefined);
    child.once("error", fail);
    child.once("close", (code) => {
      if (settled) {
        return;
      }
      if (code !== 0 || remaining !== 0 || headerLength !== 0 || resultCount !== objectIds.length) {
        fail();
        return;
      }
      settled = true;
      resolve();
    });
    child.stdin.end(`${objectIds.join("\n")}\n`);
  });
}
