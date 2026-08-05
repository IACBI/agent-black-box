import { randomUUID } from "node:crypto";
import { access, mkdir, open, readFile, readdir, rename, rm, stat } from "node:fs/promises";
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
  await writeTextFileAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

export async function writeTextFileAtomic(filePath: string, contents: string): Promise<void> {
  const directory = path.dirname(filePath);
  await ensureDir(directory);

  const temporaryPath = path.join(directory, `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
  const handle = await open(temporaryPath, "wx", 0o600);
  try {
    await handle.writeFile(contents, "utf8");
    await handle.sync();
  } catch (error) {
    await handle.close();
    await rm(temporaryPath, { force: true });
    throw error;
  }

  await handle.close();
  try {
    await rename(temporaryPath, filePath);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
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
