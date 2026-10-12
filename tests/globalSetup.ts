import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { TestProject } from "vitest/node";

declare module "vitest" {
  export interface ProvidedContext {
    /** Directory holding the compiled CLI (`cli.js`) used by the end-to-end tests. */
    abbE2eDistDir: string;
    /** Compiler output when building the CLI failed; empty on success. */
    abbE2eBuildError: string;
    /** Empty Git configuration file that replaces the developer's global Git configuration. */
    abbGitConfigGlobal: string;
  }
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cacheRoot = path.join(repoRoot, ".cache", "e2e-dist");

/**
 * Builds the shipped CLI once per vitest run and creates an isolated Git configuration file.
 * The build goes to a per-run directory under `.cache/` so it never races with `pnpm build`
 * (which cleans `dist/`) or with another vitest process running at the same time.
 */
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  await mkdir(cacheRoot, { recursive: true });
  const distDir = await mkdtemp(path.join(cacheRoot, "run-"));
  const gitConfigDir = await mkdtemp(path.join(os.tmpdir(), "abb-gitconfig-"));
  const gitConfigGlobal = path.join(gitConfigDir, "gitconfig");
  await writeFile(gitConfigGlobal, "");

  // A compile error must not block unrelated unit tests; the e2e runner reports it when a test needs the CLI.
  const buildError = compileCli(distDir);

  project.provide("abbE2eDistDir", distDir);
  project.provide("abbE2eBuildError", buildError);
  project.provide("abbGitConfigGlobal", gitConfigGlobal);

  return async () => {
    await removeQuietly(distDir);
    await removeQuietly(gitConfigDir);
  };
}

function compileCli(outDir: string): string {
  const require = createRequire(import.meta.url);
  const tsc = require.resolve("typescript/bin/tsc");
  // Declarations are not needed to run the CLI and would only slow the build down.
  const result = spawnSync(
    process.execPath,
    [tsc, "-p", path.join(repoRoot, "tsconfig.build.json"), "--outDir", outDir, "--declaration", "false"],
    { cwd: repoRoot, encoding: "utf8" }
  );
  if (result.status === 0) {
    return "";
  }
  return [
    `Compiling the CLI for end-to-end tests failed (exit ${result.status ?? "none"}).`,
    result.stdout,
    result.stderr,
  ].join("\n");
}

async function removeQuietly(dir: string): Promise<void> {
  try {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    // Leftover cache files must not fail the run.
  }
}
