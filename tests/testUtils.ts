import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

export async function createTempDir(prefix = "abb-"): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

export async function removeTempDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

export function initGitRepo(dir: string): void {
  execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
}
