import path from "node:path";

export function normalizePath(input: string): string {
  return input.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+/g, "/");
}

export function toRepoRelative(repoRoot: string, filePath: string): string {
  const relative = path.isAbsolute(filePath) ? path.relative(repoRoot, filePath) : filePath;
  return normalizePath(relative);
}

export function isPathExcluded(relativePath: string, excludePatterns: string[]): boolean {
  const normalized = normalizePath(relativePath);

  return excludePatterns.some((pattern) => pathMatchesPattern(normalized, pattern));
}

export function pathMatchesPattern(relativePath: string, pattern: string): boolean {
  const normalizedPath = normalizePath(relativePath).toLowerCase();
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

  return normalizedPath.split("/").includes(normalizedPattern);
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
