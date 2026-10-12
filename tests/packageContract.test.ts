import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, inject } from "vitest";

interface PackageManifest {
  main?: string;
  types?: string;
  bin?: Record<string, string>;
  exports?: unknown;
  files?: string[];
}

async function readManifest(): Promise<PackageManifest> {
  return JSON.parse(await readFile("package.json", "utf8")) as PackageManifest;
}

describe("package contract", () => {
  it("declares library entry points that match the build layout and the CLI executable", async () => {
    const manifest = await readManifest();

    expect(manifest.main).toBe("dist/index.js");
    expect(manifest.types).toBe("dist/index.d.ts");
    expect(manifest.bin).toEqual({ abb: "dist/cli.js" });
    expect(manifest.files).toContain("dist");
    // A deep import such as "agent-black-box/dist/..." keeps working only while no exports map is declared.
    expect(manifest).not.toHaveProperty("exports");
  });

  it("exposes the documented library API from the compiled entry point", async () => {
    const buildError = inject("abbE2eBuildError");
    expect(buildError, buildError).toBe("");
    const library = (await import(pathToFileURL(path.join(inject("abbE2eDistDir"), "index.js")).href)) as Record<
      string,
      unknown
    >;

    for (const name of [
      "loadConfig",
      "finalizeSession",
      "createSession",
      "redactCommandParts",
      "detectPossibleSecrets",
      "scanChangedFilesForSecrets",
      "compileSecretRules",
      "installPreCommitHook",
      "uninstallPreCommitHook",
      "getPreCommitHookStatus",
      "generatePullRequestComment",
      "toSessionSarif",
      "renderSessionExport",
      "verifySessions",
      "createAnalysisContentBudget",
      "inspectSessionIndexes",
      "inspectSessionArchives",
      "archiveSessionRetention",
      "planSessionRetention",
    ]) {
      expect(typeof library[name], name).toBe("function");
    }
    expect(library.PR_COMMENT_MARKER).toBe("<!-- agent-black-box:session-summary -->");
    expect(library.SARIF_VERSION).toBe("2.1.0");
  });
});
