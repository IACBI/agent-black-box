import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  isPathExcluded,
  isPathInside,
  normalizePath,
  pathMatchesPattern,
  resolveRepoPath,
  shellQuotePath,
} from "../src/utils/paths.js";

describe("path utilities", () => {
  it("normalizes Windows-style paths", () => {
    expect(normalizePath(".\\src\\cli.ts")).toBe("src/cli.ts");
  });

  it("detects ignored paths by segment and prefix", () => {
    expect(isPathExcluded("node_modules/pkg/index.js", ["node_modules"])).toBe(true);
    expect(isPathExcluded("src/node_modules/pkg/index.js", ["node_modules"])).toBe(true);
    expect(isPathExcluded(".agent-black-box/sessions/a/session.json", [".agent-black-box"])).toBe(true);
    expect(isPathExcluded("src/index.ts", ["node_modules"])).toBe(false);
  });

  it("matches single-segment patterns only on whole, case-insensitive segments", () => {
    expect(isPathExcluded("Dist", ["dist"])).toBe(true);
    expect(isPathExcluded("packages/app/DIST", ["dist"])).toBe(true);
    expect(isPathExcluded("packages/dist/index.js", ["dist"])).toBe(true);
    expect(isPathExcluded("packages/distribution/index.js", ["dist"])).toBe(false);
    expect(isPathExcluded("packages/mydist", ["dist"])).toBe(false);
    expect(isPathExcluded("src\\build\\out.js", ["build"])).toBe(true);
    expect(isPathExcluded("src/index.ts", [""])).toBe(false);
  });

  it("matches slash-separated risk patterns", () => {
    expect(pathMatchesPattern(".github/workflows/ci.yml", ".github/workflows")).toBe(true);
    expect(pathMatchesPattern("packages/app/.github/workflows/ci.yml", ".github/workflows")).toBe(true);
  });

  it("quotes paths for shell previews without allowing command breaks", () => {
    const quoted = shellQuotePath("src/weird'$(touch owned)\nfile.ts");

    expect(quoted).toBe("'src/weird'\\''$(touch owned)\\nfile.ts'");
    expect(quoted).not.toContain("\n");
  });

  it("resolves only repository-contained relative paths", () => {
    expect(resolveRepoPath("/repo", "src/index.ts")).toBeDefined();
    expect(resolveRepoPath("/repo", "../outside.txt")).toBeNull();
    expect(resolveRepoPath("/repo", "/outside.txt")).toBeNull();
  });

  it("treats the parent and its descendants as inside, and siblings or ancestors as outside", () => {
    const parent = path.resolve("repo");
    expect(isPathInside(parent, parent)).toBe(true);
    expect(isPathInside(parent, path.join(parent, "src", "index.ts"))).toBe(true);
    expect(isPathInside(parent, path.join(parent, "..foo", "file"))).toBe(true);
    expect(isPathInside(parent, path.resolve("repo-other", "file"))).toBe(false);
    expect(isPathInside(parent, path.resolve(parent, ".."))).toBe(false);
  });
});
