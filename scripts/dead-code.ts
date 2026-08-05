import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import ts from "typescript";

const projectRoot = process.cwd();
const sourceRoot = path.join(projectRoot, "src");
const entryFiles = [path.join(sourceRoot, "cli.ts"), path.join(sourceRoot, "index.ts")];
const sourceFiles = await listTypeScriptFiles(sourceRoot);
const sourceFileSet = new Set(sourceFiles.map(normalizeAbsolutePath));
const reachableFiles = new Set<string>();
const usedPackages = new Set<string>();
const pending = [...entryFiles];

while (pending.length > 0) {
  const currentFile = pending.pop();
  if (!currentFile) {
    continue;
  }

  const normalizedFile = normalizeAbsolutePath(currentFile);
  if (reachableFiles.has(normalizedFile)) {
    continue;
  }
  reachableFiles.add(normalizedFile);

  const source = ts.createSourceFile(currentFile, await readFile(currentFile, "utf8"), ts.ScriptTarget.Latest, true);
  for (const specifier of collectModuleSpecifiers(source)) {
    if (specifier.startsWith("node:")) {
      continue;
    }
    if (!specifier.startsWith(".") && !path.isAbsolute(specifier)) {
      usedPackages.add(packageNameFromSpecifier(specifier));
      continue;
    }

    const importedFile = resolveSourceImport(currentFile, specifier);
    if (importedFile && sourceFileSet.has(normalizeAbsolutePath(importedFile))) {
      pending.push(importedFile);
    }
  }
}

const unreachableFiles = sourceFiles.filter((file) => !reachableFiles.has(normalizeAbsolutePath(file)));
const packageJson = JSON.parse(await readFile(path.join(projectRoot, "package.json"), "utf8")) as {
  dependencies?: Record<string, string>;
};
const unusedDependencies = Object.keys(packageJson.dependencies ?? {}).filter(
  (dependency) => !usedPackages.has(dependency)
);

if (unreachableFiles.length > 0 || unusedDependencies.length > 0) {
  if (unreachableFiles.length > 0) {
    console.error("Unreachable source files:");
    unreachableFiles.forEach((file) => console.error(`- ${path.relative(projectRoot, file)}`));
  }
  if (unusedDependencies.length > 0) {
    console.error("Unused production dependencies:");
    unusedDependencies.forEach((dependency) => console.error(`- ${dependency}`));
  }
  process.exitCode = 1;
} else {
  console.log(
    `Dead-code check passed: ${sourceFiles.length} source files and ${usedPackages.size} production packages verified.`
  );
}

async function listTypeScriptFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        return listTypeScriptFiles(entryPath);
      }
      return Promise.resolve(entry.isFile() && entry.name.endsWith(".ts") ? [entryPath] : []);
    })
  );
  return nested.flat().sort();
}

function collectModuleSpecifiers(source: ts.SourceFile): string[] {
  const specifiers: string[] = [];
  source.forEachChild((node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      specifiers.push(node.moduleSpecifier.text);
    }
  });
  return specifiers;
}

function resolveSourceImport(importingFile: string, specifier: string): string | null {
  const resolved = path.resolve(path.dirname(importingFile), specifier);
  if (resolved.endsWith(".js")) {
    return `${resolved.slice(0, -3)}.ts`;
  }
  if (resolved.endsWith(".ts")) {
    return resolved;
  }
  return null;
}

function packageNameFromSpecifier(specifier: string): string {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

function normalizeAbsolutePath(filePath: string): string {
  const resolved = path.resolve(filePath);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}
