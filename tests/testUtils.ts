import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

export async function createTempDir(prefix = "abb-"): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

export async function removeTempDir(dir: string): Promise<void> {
  // Windows can hold handles briefly after a child process or watcher exits.
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

export function initGitRepo(dir: string): void {
  execFileSync("git", ["init", "--quiet"], { cwd: dir, stdio: "ignore" });
}
