import { simpleGit, type SimpleGit } from "simple-git";
import { resolveWindowsExecutable } from "../utils/executables.js";

let cachedWindowsGit: { searchPath: string | undefined; executable: string } | undefined;

// Preserve local Git storage/discovery settings without opting into executable or config injection.
// Pathspec modes must not override the explicit selectors used for analysis and literal rollback paths.
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

/**
 * Environment for a Git child process started outside simple-git: the caller's variables without the
 * `GIT_*` ones, except the local storage and discovery settings that {@link createGit} also keeps.
 * Variables such as `GIT_EXTERNAL_DIFF` or `GIT_SSH_COMMAND` can make Git run a program of the caller's choosing.
 */
export function gitProcessEnvironment(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const allowed = new Set<string>(LOCAL_GIT_ENVIRONMENT);
  const filtered: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(env)) {
    if (!name.toUpperCase().startsWith("GIT_") || allowed.has(name.toUpperCase())) {
      filtered[name] = value;
    }
  }
  return filtered;
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
