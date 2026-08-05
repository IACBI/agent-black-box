import { readFile } from "node:fs/promises";
import path from "node:path";

const projectRoot = process.cwd();
const packageJson = JSON.parse(await readFile(path.join(projectRoot, "package.json"), "utf8")) as { version?: unknown };
const version = packageJson.version;

if (typeof version !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
  throw new Error("package.json must contain a valid semver version before release.");
}

const changelog = await readFile(path.join(projectRoot, "CHANGELOG.md"), "utf8");
if (!changelog.split(/\r?\n/).includes(`## ${version}`)) {
  throw new Error(`CHANGELOG.md must contain an exact \`## ${version}\` heading.`);
}

const releaseTag = process.env.RELEASE_TAG;
if (releaseTag && releaseTag !== `v${version}`) {
  throw new Error(`RELEASE_TAG must be v${version}; received ${releaseTag}.`);
}

console.log(`Release metadata is valid for v${version}${releaseTag ? ` (${releaseTag})` : ""}.`);
