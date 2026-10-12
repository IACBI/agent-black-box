import { readFile } from "node:fs/promises";
import path from "node:path";

const projectRoot = process.cwd();
const packageJson = JSON.parse(await readFile(path.join(projectRoot, "package.json"), "utf8")) as {
  version?: unknown;
  main?: unknown;
  types?: unknown;
  bin?: Record<string, unknown>;
};
const version = packageJson.version;

if (typeof version !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
  throw new Error("package.json must contain a valid semver version before release.");
}

const changelog = await readFile(path.join(projectRoot, "CHANGELOG.md"), "utf8");
if (!changelog.split(/\r?\n/).includes(`## ${version}`)) {
  throw new Error(`CHANGELOG.md must contain an exact \`## ${version}\` heading.`);
}

const cliSource = await readFile(path.join(projectRoot, "src", "cli.ts"), "utf8");
if (!cliSource.includes(`.version("${version}")`)) {
  throw new Error(`src/cli.ts must report .version("${version}") to match package.json.`);
}

// The published entry points must exist in the build output and the CLI must keep its shebang.
const binTarget = packageJson.bin?.abb;
if (typeof binTarget !== "string") {
  throw new Error("package.json must declare the abb executable in bin.");
}
for (const [field, target] of [
  ["bin.abb", binTarget],
  ["main", packageJson.main],
  ["types", packageJson.types],
] as const) {
  if (typeof target !== "string") {
    throw new Error(`package.json must declare ${field}.`);
  }
  try {
    await readFile(path.join(projectRoot, target));
  } catch {
    throw new Error(`package.json ${field} points to ${target}, which does not exist. Run \`pnpm build\` first.`);
  }
}
const cliBuild = await readFile(path.join(projectRoot, binTarget), "utf8");
if (!cliBuild.startsWith("#!/usr/bin/env node\n")) {
  throw new Error(`${binTarget} must start with the node shebang line.`);
}

const releaseTag = process.env.RELEASE_TAG;
if (releaseTag && releaseTag !== `v${version}`) {
  throw new Error(`RELEASE_TAG must be v${version}; received ${releaseTag}.`);
}

console.log(`Release metadata is valid for v${version}${releaseTag ? ` (${releaseTag})` : ""}.`);
