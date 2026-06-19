import { describe, expect, it } from "vitest";
import { isPathExcluded, normalizePath, pathMatchesPattern, shellQuotePath } from "../src/utils/paths.js";

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

  it("matches slash-separated risk patterns", () => {
    expect(pathMatchesPattern(".github/workflows/ci.yml", ".github/workflows")).toBe(true);
    expect(pathMatchesPattern("packages/app/.github/workflows/ci.yml", ".github/workflows")).toBe(true);
  });

  it("quotes paths for shell previews without allowing command breaks", () => {
    const quoted = shellQuotePath("src/weird'$(touch owned)\nfile.ts");

    expect(quoted).toBe("'src/weird'\\''$(touch owned)\\nfile.ts'");
    expect(quoted).not.toContain("\n");
  });
});
