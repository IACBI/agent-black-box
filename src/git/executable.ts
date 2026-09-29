import { simpleGit, type SimpleGit } from "simple-git";
import { resolveWindowsExecutable } from "../utils/executables.js";

let cachedWindowsGit: { searchPath: string | undefined; executable: string } | undefined;

/**
 * Returns the Git executable to run. On Windows it is resolved through absolute PATH entries only,
 * so a `git.exe` inside the repository being analyzed is never executed.
 */
export function gitExecutable(): string {
  if (process.platform !== "win32") {
    return "git";
  }

  const searchPath = process.env.PATH;
  if (cachedWindowsGit && cachedWindowsGit.searchPath === searchPath) {
    return cachedWindowsGit.executable;
  }

  const executable = resolveWindowsExecutable("git", process.cwd());
  if (!executable) {
    throw new Error("Git was not found in PATH.");
  }
  cachedWindowsGit = { searchPath, executable };
  return executable;
}

export function createGit(baseDir: string): SimpleGit {
  const binary = gitExecutable();
  // The default validation rejects paths such as "C:\Program Files\Git\..."; this value is an
  // existing file found on PATH by resolveWindowsExecutable, never caller-supplied text.
  return simpleGit({ baseDir, binary, unsafe: { allowUnsafeCustomBinary: binary !== "git" } });
}
