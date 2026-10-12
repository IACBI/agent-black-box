import { lstatSync } from "node:fs";
import path from "node:path";

const WINDOWS_EXECUTABLE_EXTENSIONS = [".com", ".exe", ".bat", ".cmd"];
const DEFAULT_PATHEXT = ".COM;.EXE;.BAT;.CMD";

/**
 * Locates an executable the way `cmd.exe` would, in PATHEXT order, but only through absolute PATH
 * entries. Windows process creation otherwise searches the current directory first, which would let
 * a file planted in a repository under review shadow a real tool. Names with a directory part
 * resolve against `cwd`. Returns null when nothing matches.
 */
export function resolveWindowsExecutable(
  command: string,
  cwd: string,
  env: NodeJS.ProcessEnv = process.env
): string | null {
  const hasDirectory = /[\\/]/.test(command);
  const directories = hasDirectory
    ? [path.resolve(cwd, path.dirname(command))]
    : (env.PATH ?? "")
        .split(path.delimiter)
        .map((directory) => directory.replace(/^"(.*)"$/, "$1"))
        .filter((directory) => path.isAbsolute(directory));
  const baseName = path.basename(command);
  const extensions = candidateExtensions(baseName, env);

  for (const directory of directories) {
    for (const extension of extensions) {
      const candidate = path.join(directory, `${baseName}${extension}`);
      try {
        if (!lstatSync(candidate).isDirectory()) {
          return candidate;
        }
      } catch {
        // Missing or unreadable candidates are skipped.
      }
    }
  }
  return null;
}

/**
 * An executable extension (`git.exe`) is used as given and an extensionless name is expanded. Any other
 * dotted name (`python3.12`) is also expanded, as cmd.exe does, and then tried verbatim as a last resort.
 */
function candidateExtensions(baseName: string, env: NodeJS.ProcessEnv): string[] {
  const extension = path.extname(baseName).toLowerCase();
  if (WINDOWS_EXECUTABLE_EXTENSIONS.includes(extension)) {
    return [""];
  }
  const expanded = getWindowsExecutableExtensions(env);
  return extension === "" ? expanded : [...expanded, ""];
}

function getWindowsExecutableExtensions(env: NodeJS.ProcessEnv): string[] {
  return (env.PATHEXT ?? DEFAULT_PATHEXT)
    .split(";")
    .map((extension) => extension.toLowerCase())
    .filter((extension) => WINDOWS_EXECUTABLE_EXTENSIONS.includes(extension));
}
