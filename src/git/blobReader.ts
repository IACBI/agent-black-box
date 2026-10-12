import { spawn } from "node:child_process";
import { gitExecutable, gitProcessEnvironment } from "./executable.js";

const OBJECT_ID = /^[0-9a-f]{40,64}$/;
const HEADER = /^([0-9a-f]{40,64}) (\S+) (\d+)$/;
const MAX_HEADER_BYTES = 512;
const LINE_FEED = 0x0a;
const FAILURE_MESSAGE = "Could not read a staged Git blob.";

/**
 * Reads blobs with one `git cat-file --batch` process instead of one process per file. The result lines up
 * with `objectIds`; an entry is `null` when that blob is larger than `maxBytes` (its content is never
 * buffered). A missing object, a non-blob object, or any Git failure rejects, as `git cat-file blob` would.
 */
export function readGitBlobs(
  repoRoot: string,
  objectIds: readonly string[],
  maxBytes: number
): Promise<Array<Buffer | null>> {
  if (!objectIds.every((objectId) => OBJECT_ID.test(objectId))) {
    return Promise.reject(new Error("Blob identifiers must be full Git object IDs."));
  }
  if (objectIds.length === 0) {
    return Promise.resolve([]);
  }

  return new Promise((resolve, reject) => {
    const child = spawn(gitExecutable(), ["cat-file", "--batch"], {
      cwd: repoRoot,
      env: gitProcessEnvironment(),
      stdio: ["pipe", "pipe", "ignore"],
      windowsHide: true,
    });
    const results: Array<Buffer | null> = [];
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
      if (!match || match[2] !== "blob") {
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
          results.push(body === null ? null : Buffer.concat(body, bodySize));
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
      if (code !== 0 || remaining !== 0 || headerLength !== 0 || results.length !== objectIds.length) {
        fail();
        return;
      }
      settled = true;
      resolve(results);
    });
    child.stdin.end(`${objectIds.join("\n")}\n`);
  });
}
