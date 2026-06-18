import { access, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

export async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function ensureDir(dirPath: string): Promise<void> {
  await mkdir(dirPath, { recursive: true });
}

export async function readJsonFile<T>(filePath: string): Promise<T> {
  const raw = await readFile(filePath, "utf8");
  return JSON.parse(raw) as T;
}

export async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
  await ensureDir(path.dirname(filePath));
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export async function removeFileIfExists(filePath: string): Promise<void> {
  await rm(filePath, { force: true });
}

export async function getNewestDirectory(parentDir: string): Promise<string | null> {
  if (!(await pathExists(parentDir))) {
    return null;
  }

  const entries = await readdir(parentDir, { withFileTypes: true });
  const directories = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        const fullPath = path.join(parentDir, entry.name);
        const stats = await stat(fullPath);
        return { fullPath, mtimeMs: stats.mtimeMs };
      })
  );

  directories.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return directories[0]?.fullPath ?? null;
}
