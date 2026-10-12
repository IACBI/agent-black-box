import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readGitBlobs } from "../src/git/blobReader.js";
import { gitProcessEnvironment } from "../src/git/executable.js";
import { createTempDir, initGitRepo, removeTempDir } from "./testUtils.js";

function git(cwd: string, args: string[], input?: Buffer): string {
  return execFileSync("git", args, { cwd, input, encoding: "utf8" }).trim();
}

describe("batched Git blob reading", () => {
  let repo: string;

  beforeEach(async () => {
    repo = await createTempDir("abb-blob-reader-");
    initGitRepo(repo);
  });

  afterEach(async () => {
    await removeTempDir(repo);
  });

  function storeBlob(content: Buffer): string {
    return git(repo, ["hash-object", "-w", "--stdin"], content);
  }

  it("returns each blob's exact bytes in request order, including duplicates and empty content", async () => {
    const blobs = [
      Buffer.from("first\n"),
      Buffer.alloc(0),
      Buffer.from("line one\r\nline two\n\n"),
      Buffer.from([0, 255, 10, 13, 0, 10, 10]),
      Buffer.from("日本語 é emoji 😀"),
    ];
    const ids = blobs.map(storeBlob);

    const result = await readGitBlobs(repo, [ids[2]!, ids[0]!, ids[1]!, ids[0]!, ids[4]!, ids[3]!], 1024);

    expect(result).toEqual([blobs[2], blobs[0], blobs[1], blobs[0], blobs[4], blobs[3]]);
    expect(result.every((blob) => Buffer.isBuffer(blob))).toBe(true);
  });

  it("returns null for a blob over the limit, keeps neighbours intact, and treats the limit as inclusive", async () => {
    const atLimit = Buffer.alloc(100, "a");
    const overLimit = Buffer.alloc(101, "b");
    const small = Buffer.from("small");
    const ids = [small, overLimit, atLimit, small].map(storeBlob);

    expect(await readGitBlobs(repo, ids, 100)).toEqual([small, null, atLimit, small]);
    expect(await readGitBlobs(repo, ids, 101)).toEqual([small, overLimit, atLimit, small]);
    expect(await readGitBlobs(repo, ids, 4)).toEqual([null, null, null, null]);
  });

  it("reassembles large blobs delivered across many pipe chunks", async () => {
    const large = randomBytes(1024 * 1024 + 17);
    const [id] = [storeBlob(large)];
    const trailing = storeBlob(Buffer.from("after"));

    const [first, second] = await readGitBlobs(repo, [id!, trailing], 2 * 1024 * 1024);

    expect(first?.equals(large)).toBe(true);
    expect(second?.toString()).toBe("after");
  });

  it("reads thousands of blobs with one request", async () => {
    const files = Array.from({ length: 1500 }, (_, index) => Buffer.from(`file ${index}\n`));
    await Promise.all(files.map((content, index) => writeFile(path.join(repo, `blob-${index}.txt`), content)));
    // One hash-object process for all files keeps the fixture cheap; the reader under test then uses one more.
    const paths = files.map((_, index) => `blob-${index}.txt`).join("\n");
    const ids = git(repo, ["hash-object", "-w", "--stdin-paths"], Buffer.from(`${paths}\n`)).split(/\r?\n/);
    expect(ids).toHaveLength(files.length);

    const result = await readGitBlobs(repo, ids, 1024);

    expect(result.map((blob) => blob?.toString())).toEqual(files.map((blob) => blob.toString()));
  }, 120_000);

  it("resolves an empty request without starting Git", async () => {
    await expect(readGitBlobs(path.join(repo, "does-not-exist"), [], 10)).resolves.toEqual([]);
  });

  it.each([
    ["a name instead of an object id", "HEAD"],
    ["an option-looking value", "--batch-all-objects"],
    ["a short abbreviation", "abc123"],
    ["an id followed by a second line", `${"a".repeat(40)}\n${"b".repeat(40)}`],
    ["upper-case hex", "A".repeat(40)],
  ])("rejects %s before starting Git", async (_label, identifier) => {
    await expect(readGitBlobs(repo, [identifier], 10)).rejects.toThrow("Blob identifiers must be full Git object IDs.");
  });

  it("rejects an object that does not exist, instead of returning partial results", async () => {
    const existing = storeBlob(Buffer.from("exists"));

    await expect(readGitBlobs(repo, [existing, "0".repeat(40)], 100)).rejects.toThrow(
      "Could not read a staged Git blob."
    );
  });

  it("rejects an object that is not a blob", async () => {
    await writeFile(path.join(repo, "a.txt"), "a\n");
    git(repo, ["add", "a.txt"]);
    const treeId = git(repo, ["write-tree"]);

    await expect(readGitBlobs(repo, [treeId], 100)).rejects.toThrow("Could not read a staged Git blob.");
  });

  it("rejects when the directory is not a repository", async () => {
    const outside = await createTempDir("abb-blob-reader-outside-");
    try {
      await expect(readGitBlobs(outside, ["a".repeat(40)], 100)).rejects.toThrow("Could not read a staged Git blob.");
    } finally {
      await removeTempDir(outside);
    }
  });
});

describe("Git child-process environment", () => {
  it("keeps ordinary variables and local discovery settings but drops variables that can run programs", () => {
    const filtered = gitProcessEnvironment({
      PATH: "/bin",
      HOME: "/home/a",
      GIT_DIR: "/repo/.git",
      GIT_OBJECT_DIRECTORY: "/objects",
      git_index_file: "/index",
      GIT_EXTERNAL_DIFF: "evil",
      GIT_SSH_COMMAND: "evil",
      GIT_CONFIG_GLOBAL: "/tmp/config",
      GIT_ASKPASS: "evil",
    });

    expect(filtered).toEqual({
      PATH: "/bin",
      HOME: "/home/a",
      GIT_DIR: "/repo/.git",
      GIT_OBJECT_DIRECTORY: "/objects",
      git_index_file: "/index",
    });
  });

  it("does not mutate the environment it was given", () => {
    const source = { GIT_EXTERNAL_DIFF: "evil", PATH: "/bin" };
    gitProcessEnvironment(source);

    expect(source).toEqual({ GIT_EXTERNAL_DIFF: "evil", PATH: "/bin" });
  });
});
