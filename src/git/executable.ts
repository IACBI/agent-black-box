import { simpleGit, type SimpleGit } from "simple-git";
import { resolveWindowsExecutable } from "../utils/executables.js";

let cachedWindowsGit: { searchPath: string | undefined; executable: string } | undefined;

// Preserve local Git storage/discovery settings without opting into executable or config injection.
const LOCAL_GIT_ENVIRONMENT = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_COMMON_DIR",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_NAMESPACE",
  "GIT_CEILING_DIRECTORIES",
  "GIT_DISCOVERY_ACROSS_FILESYSTEM",
  "GIT_OPTIONAL_LOCKS",
  "GIT_INDEX_VERSION",
  "GIT_NO_REPLACE_OBJECTS",
  "GIT_REPLACE_REF_BASE",
  "GIT_LITERAL_PATHSPECS",
  "GIT_GLOB_PATHSPECS",
  "GIT_NOGLOB_PATHSPECS",
  "GIT_ICASE_PATHSPECS",
] as const;

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
  return simpleGit({
    baseDir,
    binary,
    allowEnvironment: LOCAL_GIT_ENVIRONMENT,
    unsafe: { allowUnsafeCustomBinary: binary !== "git" },
  });
}
