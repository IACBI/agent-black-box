import { randomUUID } from "node:crypto";
import { cp, lstat, mkdir, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AgentBlackBoxConfig } from "../types.js";
import { digestRegularFile } from "./reportStorage.js";
import { listSessionCatalog, verifyCatalogSessionReportFile, type SessionCatalogEntry } from "./sessionCatalog.js";
import { getActiveSessionPath, getSessionLockPath, getSessionRoot } from "./sessionManager.js";

export interface SessionRetentionPlan {
  before: string;
  keep: number;
  sessions: Array<{ id: string; startedAt: string }>;
}

export function planSessionRetention(
  entries: readonly SessionCatalogEntry[],
  before: string,
  keep = 1
): SessionRetentionPlan {
  const cutoff = parseRetentionDate(before);
  if (!Number.isSafeInteger(keep) || keep < 1) {
    throw new Error("--keep must be a positive integer.");
  }
  const complete = entries
    .filter((entry) => entry.state === "complete" && entry.startedAt && Number.isFinite(Date.parse(entry.startedAt)))
    .sort(
      (left, right) => Date.parse(right.startedAt!) - Date.parse(left.startedAt!) || right.id.localeCompare(left.id)
    );
  const sessions = complete.slice(keep).filter((entry) => Date.parse(entry.startedAt!) < cutoff);
  return {
    before,
    keep,
    sessions: sessions.map((entry) => ({ id: entry.id, startedAt: entry.startedAt! })),
  };
}

export function retentionDateForDays(days: number, now = new Date()): string {
  if (!Number.isSafeInteger(days) || days < 1 || days > 100_000 || !Number.isFinite(now.getTime())) {
    throw new Error("Retention days must be an integer between 1 and 100000.");
  }
  const cutoff = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - days));
  return cutoff.toISOString().slice(0, 10);
}

export function renderSessionRetentionPlan(plan: SessionRetentionPlan): string {
  const lines = [
    `Completed sessions before ${plan.before} (UTC), keeping the newest ${plan.keep}:`,
    ...plan.sessions.map((session) => `- ${session.id} | started ${session.startedAt}`),
    `${plan.sessions.length} session(s) eligible for deletion.`,
  ];
  return `${lines.join("\n")}\n`;
}

export async function applySessionRetention(
  repoRoot: string,
  config: AgentBlackBoxConfig,
  plan: SessionRetentionPlan
): Promise<void> {
  if (plan.sessions.length === 0) {
    return;
  }
  if (
    (await existsStrict(getActiveSessionPath(repoRoot, config))) ||
    (await existsStrict(getSessionLockPath(repoRoot, config)))
  ) {
    throw new Error("A session is active or its state needs recovery; retention was cancelled.");
  }

  const current = planSessionRetention(await listSessionCatalog(repoRoot, config), plan.before, plan.keep);
  if (JSON.stringify(current.sessions) !== JSON.stringify(plan.sessions)) {
    throw new Error("Session history changed since the preview; run retention again.");
  }

  const sessionRoot = getSessionRoot(repoRoot, config);
  const rootInfo = await lstat(sessionRoot);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw new Error("Session root is not a regular directory.");
  }
  const physicalRoot = await realpath(sessionRoot);
  const entries = await listSessionCatalog(repoRoot, config);
  for (const session of plan.sessions) {
    const entry = entries.find((candidate) => candidate.id === session.id && candidate.state === "complete");
    if (!entry || entry.startedAt !== session.startedAt) {
      throw new Error(`Session ${session.id} changed since the preview.`);
    }
    await verifyCatalogSessionReportFile(entry);
    await verifySafeSessionDirectory(physicalRoot, entry.sessionDir, entry.id);
  }

  for (const session of plan.sessions) {
    if (
      (await existsStrict(getActiveSessionPath(repoRoot, config))) ||
      (await existsStrict(getSessionLockPath(repoRoot, config)))
    ) {
      throw new Error("Session state changed during retention; remaining sessions were left untouched.");
    }
    const source = path.join(sessionRoot, session.id);
    await verifySafeSessionDirectory(physicalRoot, source, session.id);
    const quarantine = path.join(sessionRoot, `.pruning-${session.id}-${randomUUID()}`);
    await rename(source, quarantine);
    // A failed removal leaves a clearly named directory for manual recovery.
    await rejectLinks(quarantine);
    await rm(quarantine, { recursive: true });
  }
}

export async function archiveSessionRetention(
  repoRoot: string,
  config: AgentBlackBoxConfig,
  plan: SessionRetentionPlan,
  archiveDir: string
): Promise<void> {
  if (plan.sessions.length === 0) {
    return;
  }
  if (
    (await existsStrict(getActiveSessionPath(repoRoot, config))) ||
    (await existsStrict(getSessionLockPath(repoRoot, config)))
  ) {
    throw new Error("A session is active or its state needs recovery; archiving was cancelled.");
  }
  const entries = await listSessionCatalog(repoRoot, config);
  const current = planSessionRetention(entries, plan.before, plan.keep);
  if (JSON.stringify(current.sessions) !== JSON.stringify(plan.sessions)) {
    throw new Error("Session history changed since the preview; run archiving again.");
  }

  const sessionRoot = getSessionRoot(repoRoot, config);
  const rootInfo = await lstat(sessionRoot);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw new Error("Session root is not a regular directory.");
  }
  const physicalRoot = await realpath(sessionRoot);
  for (const session of plan.sessions) {
    const entry = entries.find((candidate) => candidate.id === session.id && candidate.state === "complete");
    if (!entry || entry.startedAt !== session.startedAt) {
      throw new Error(`Session ${session.id} changed since the preview.`);
    }
    await verifyCatalogSessionReportFile(entry);
    await verifySafeSessionDirectory(physicalRoot, entry.sessionDir, entry.id);
  }

  const archiveRoot = await prepareArchiveRoot(repoRoot, physicalRoot, archiveDir);
  for (const session of plan.sessions) {
    if (await existsStrict(path.join(archiveRoot, session.id))) {
      throw new Error(`Archive destination already contains ${session.id}; no sessions were copied.`);
    }
  }
  for (const session of plan.sessions) {
    if (
      (await existsStrict(getActiveSessionPath(repoRoot, config))) ||
      (await existsStrict(getSessionLockPath(repoRoot, config)))
    ) {
      throw new Error("Session state changed during archiving; remaining sessions were left untouched.");
    }
    const source = path.join(sessionRoot, session.id);
    await verifySafeSessionDirectory(physicalRoot, source, session.id);
    const destination = path.join(archiveRoot, session.id);
    await mkdir(destination, { mode: 0o700 });
    for (const name of await readdir(source)) {
      await cp(path.join(source, name), path.join(destination, name), {
        recursive: true,
        errorOnExist: true,
        force: false,
        dereference: false,
      });
    }
    await rejectLinks(destination);
    await verifyDirectoryCopy(source, destination);
    await writeFile(
      path.join(destination, ".abb-archive-complete.json"),
      `${JSON.stringify({ archiveVersion: 1, id: session.id, archivedAt: new Date().toISOString() })}\n`,
      { encoding: "utf8", flag: "wx", mode: 0o600 }
    );
  }
}

export function renderSessionArchivePlan(plan: SessionRetentionPlan, archiveDir: string): string {
  const lines = [
    `Completed sessions before ${plan.before} (UTC), keeping the newest ${plan.keep}:`,
    `Archive destination: ${archiveDir}`,
    ...plan.sessions.map((session) => `- ${session.id} | started ${session.startedAt}`),
    `${plan.sessions.length} session(s) eligible for archival. Original sessions remain in place.`,
  ];
  return `${lines.join("\n")}\n`;
}

async function prepareArchiveRoot(repoRoot: string, sessionRoot: string, configuredPath: string): Promise<string> {
  if (!configuredPath.trim() || /^(?:\\\\|\/\/)/.test(configuredPath) || /^\\\\\?\\UNC\\/i.test(configuredPath)) {
    throw new Error("Archive destination must be a non-empty local path.");
  }
  const archivePath = path.resolve(repoRoot, configuredPath);
  const relative = path.relative(sessionRoot, archivePath);
  if (relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))) {
    throw new Error("Archive destination must stay outside the session root.");
  }
  await mkdir(archivePath, { recursive: true, mode: 0o700 });
  const info = await lstat(archivePath);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error("Archive destination is not a regular directory.");
  }
  const physicalArchive = await realpath(archivePath);
  const physicalRelative = path.relative(sessionRoot, physicalArchive);
  if (
    physicalRelative === "" ||
    (physicalRelative !== ".." && !physicalRelative.startsWith(`..${path.sep}`) && !path.isAbsolute(physicalRelative))
  ) {
    throw new Error("Archive destination must stay outside the session root, including through links.");
  }
  return physicalArchive;
}

async function verifyDirectoryCopy(source: string, destination: string): Promise<void> {
  const sourceNames = (await readdir(source)).sort();
  const copiedNames = (await readdir(destination)).sort();
  if (JSON.stringify(sourceNames) !== JSON.stringify(copiedNames)) {
    throw new Error("Archived session contents differ from the source.");
  }
  for (const name of sourceNames) {
    const sourcePath = path.join(source, name);
    const copiedPath = path.join(destination, name);
    const [original, copy] = await Promise.all([lstat(sourcePath), lstat(copiedPath)]);
    if (original.isDirectory() && copy.isDirectory()) {
      await verifyDirectoryCopy(sourcePath, copiedPath);
    } else if (original.isFile() && copy.isFile()) {
      const [sourceDigest, copiedDigest] = await Promise.all([
        digestRegularFile(sourcePath),
        digestRegularFile(copiedPath),
      ]);
      if (sourceDigest.bytes !== copiedDigest.bytes || sourceDigest.digest !== copiedDigest.digest) {
        throw new Error("Archived session contents differ from the source.");
      }
    } else {
      throw new Error("Archived session contains a linked or special file.");
    }
  }
}

async function existsStrict(filePath: string): Promise<boolean> {
  try {
    await lstat(filePath);
    return true;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function verifySafeSessionDirectory(root: string, directory: string, id: string): Promise<void> {
  if (path.dirname(directory) !== root && (await realpath(path.dirname(directory))) !== root) {
    throw new Error(`Session ${id} is outside the configured session root.`);
  }
  if (path.basename(directory) !== id || (await realpath(directory)) !== path.join(root, id)) {
    throw new Error(`Session ${id} has an unexpected physical location.`);
  }
  await rejectLinks(directory);
}

async function rejectLinks(directory: string): Promise<void> {
  const info = await lstat(directory);
  if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile())) {
    throw new Error(`Retention refused a linked or special file in ${directory}.`);
  }
  if (!info.isDirectory()) {
    return;
  }
  for (const name of await readdir(directory)) {
    await rejectLinks(path.join(directory, name));
  }
}

function parseRetentionDate(value: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error("--before must be a date in YYYY-MM-DD format.");
  }
  const timestamp = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== value) {
    throw new Error("--before must be a valid date in YYYY-MM-DD format.");
  }
  return timestamp;
}
