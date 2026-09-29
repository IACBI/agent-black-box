import path from "node:path";

export function normalizePath(input: string): string {
  // Most paths are already normalized; skip the regex passes on this hot path.
  if (!input.includes("\\") && !input.includes("//") && !input.startsWith("./")) {
    return input;
  }
  return input.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+/g, "/");
}

export function toRepoRelative(repoRoot: string, filePath: string): string {
  const relative = path.isAbsolute(filePath) ? path.relative(repoRoot, filePath) : filePath;
  return normalizePath(relative);
}

export function resolveRepoPath(repoRoot: string, relativePath: string): string | null {
  if (path.isAbsolute(relativePath)) {
    return null;
  }

  const resolved = path.resolve(repoRoot, relativePath);
  return isPathInside(repoRoot, resolved) ? resolved : null;
}

/** Lexical containment check; the parent itself counts as inside. Does not resolve links. */
export function isPathInside(parentPath: string, candidatePath: string): boolean {
  const relative = path.relative(parentPath, candidatePath);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

export function isPathExcluded(relativePath: string, excludePatterns: string[]): boolean {
  const normalizedPath = normalizePath(relativePath).toLowerCase();

  return excludePatterns.some((pattern) => matchesNormalizedPath(normalizedPath, pattern));
}

export function pathMatchesPattern(relativePath: string, pattern: string): boolean {
  return matchesNormalizedPath(normalizePath(relativePath).toLowerCase(), pattern);
}

function matchesNormalizedPath(normalizedPath: string, pattern: string): boolean {
  const normalizedPattern = normalizePath(pattern).toLowerCase();

  if (!normalizedPattern) {
    return false;
  }

  if (normalizedPath === normalizedPattern || normalizedPath.startsWith(`${normalizedPattern}/`)) {
    return true;
  }

  if (normalizedPattern.includes("/")) {
    return normalizedPath.includes(`/${normalizedPattern}/`) || normalizedPath.endsWith(`/${normalizedPattern}`);
  }

  return hasPathSegment(normalizedPath, normalizedPattern);
}

function hasPathSegment(normalizedPath: string, segment: string): boolean {
  let start = 0;
  while (start <= normalizedPath.length) {
    const separator = normalizedPath.indexOf("/", start);
    const end = separator === -1 ? normalizedPath.length : separator;
    if (end - start === segment.length && normalizedPath.startsWith(segment, start)) {
      return true;
    }
    start = end + 1;
  }
  return false;
}

export function shellQuotePath(relativePath: string): string {
  let quoted = "'";

  for (const character of relativePath) {
    switch (character) {
      case "'":
        quoted += "'\\''";
        break;
      case "\r":
        quoted += "\\r";
        break;
      case "\n":
        quoted += "\\n";
        break;
      case "\0":
        quoted += "\\0";
        break;
      default:
        quoted += character;
        break;
    }
  }

  return `${quoted}'`;
}
