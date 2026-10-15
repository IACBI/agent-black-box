import { randomUUID } from "node:crypto";
import { cp, lstat, mkdir, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AgentBlackBoxConfig } from "../types.js";
import { digestRegularFile } from "./reportStorage.js";
import {
  listSessionCatalog,
  readVerifiedCatalogSessionReportCore,
  type SessionCatalogEntry,
} from "./sessionCatalog.js";
import { getActiveSessionPath, getSessionLockPath, getSessionRoot } from "./sessionManager.js";
import { isPathInside } from "../utils/paths.js";
import { formatTerminalValue } from "../utils/terminal.js";
import { readJsonFileLimited } from "../utils/files.js";
import { isRecord } from "../utils/records.js";

const ARCHIVE_COMPLETE_FILE = ".abb-archive-complete.json";
/** Files are copied under this suffix and renamed, so an interrupted copy never masquerades as a final file. */
const ARCHIVE_PARTIAL_SUFFIX = ".abb-partial";

export interface SessionArchiveInspection {
  id: string;
  status: "missing" | "resumable" | "complete" | "conflict";
  message?: string;
}

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
    `Completed sessions before ${formatTerminalValue(plan.before)} (UTC), keeping the newest ${plan.keep}:`,
    ...plan.sessions.map(
      (session) => `- ${formatTerminalValue(session.id)} | started ${formatTerminalValue(session.startedAt)}`
    ),
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

  const sessionRoot = getSessionRoot(repoRoot, config);
  const rootInfo = await lstat(sessionRoot);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw new Error("Session root is not a regular directory.");
  }
  const physicalRoot = await realpath(sessionRoot);
  const entries = await listSessionCatalog(repoRoot, config);
  await verifyRetentionCatalog(entries, physicalRoot, plan);
  const completeEntries = indexCompleteEntries(entries);
  for (const session of plan.sessions) {
    const entry = completeEntries.get(session.id);
    if (!entry || entry.startedAt !== session.startedAt) {
      throw new Error(`Session ${session.id} changed since the preview.`);
    }
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
    await verifyRetentionSession(completeEntries.get(session.id)!, session.startedAt);
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
  archiveDir: string,
  options: { resume?: boolean } = {}
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
  const sessionRoot = getSessionRoot(repoRoot, config);
  const rootInfo = await lstat(sessionRoot);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw new Error("Session root is not a regular directory.");
  }
  const physicalRoot = await realpath(sessionRoot);
  await verifyRetentionCatalog(entries, physicalRoot, plan);
  const completeEntries = indexCompleteEntries(entries);
  for (const session of plan.sessions) {
    const entry = completeEntries.get(session.id);
    if (!entry || entry.startedAt !== session.startedAt) {
      throw new Error(`Session ${session.id} changed since the preview.`);
    }
    await verifySafeSessionDirectory(physicalRoot, entry.sessionDir, entry.id);
  }

  const archiveRoot = await prepareArchiveRoot(repoRoot, physicalRoot, archiveDir);
  const inspections = options.resume ? await inspectSessionArchives(repoRoot, config, plan, archiveDir) : [];
  const conflict = inspections.find((inspection) => inspection.status === "conflict");
  if (conflict) {
    throw new Error(`Archive ${conflict.id} cannot be resumed: ${conflict.message}`);
  }
  for (const session of plan.sessions) {
    if (!options.resume && (await existsStrict(path.join(archiveRoot, session.id)))) {
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
    if (options.resume) {
      // Recheck immediately before mutation; never overwrite a partial file or a divergent completed copy.
      const inspection = await inspectArchive(source, destination, session.id);
      if (inspection.status === "conflict") {
        throw new Error(`Archive ${session.id} cannot be resumed: ${inspection.message}`);
      }
      if (inspection.status === "complete") {
        continue;
      }
    }
    if (!options.resume || !(await existsStrict(destination))) {
      await mkdir(destination, { mode: 0o700 });
    }
    const destinationInfo = await lstat(destination);
    if (!destinationInfo.isDirectory() || destinationInfo.isSymbolicLink()) {
      throw new Error("Archive session is not a regular directory.");
    }
    await rejectLinks(destination);
    await copyMissingArchiveFiles(source, destination);
    await rejectLinks(destination);
    await verifyArchiveSubset(source, destination, true, false);
    await verifyRetentionSession(completeEntries.get(session.id)!, session.startedAt);
    await writeFile(
      path.join(destination, ARCHIVE_COMPLETE_FILE),
      `${JSON.stringify({ archiveVersion: 1, id: session.id, archivedAt: new Date().toISOString() })}\n`,
      { encoding: "utf8", flag: "wx", mode: 0o600 }
    );
  }
}

/** Read-only preflight. An existing copy is resumable only when every existing byte agrees with the source. */
export async function inspectSessionArchives(
  repoRoot: string,
  config: AgentBlackBoxConfig,
  plan: SessionRetentionPlan,
  archiveDir: string
): Promise<SessionArchiveInspection[]> {
  if (plan.sessions.length === 0) {
    return [];
  }
  if (!archiveDir.trim() || /^(?:\\\\|\/\/)/.test(archiveDir) || /^\\\\\?\\UNC\\/i.test(archiveDir)) {
    throw new Error("Archive destination must be a non-empty local path.");
  }
  const sessionRoot = getSessionRoot(repoRoot, config);
  const rootInfo = await lstat(sessionRoot);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw new Error("Session root is not a regular directory.");
  }
  const physicalRoot = await realpath(sessionRoot);
  const archivePath = path.resolve(repoRoot, archiveDir);
  const ancestor = await nearestExistingAncestor(archivePath);
  const physicalAncestor = await realpath(ancestor);
  const physicalArchive = path.resolve(physicalAncestor, path.relative(ancestor, archivePath));
  if (isPathInside(physicalRoot, archivePath) || isPathInside(physicalRoot, physicalArchive)) {
    throw new Error("Archive destination must stay outside the session root, including through links.");
  }
  if (await existsStrict(archivePath)) {
    const info = await lstat(archivePath);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error("Archive destination is not a regular directory.");
    }
  }
  const catalog = await listSessionCatalog(repoRoot, config);
  await verifyRetentionCatalog(catalog, physicalRoot, plan);
  const entries = indexCompleteEntries(catalog);
  const inspections: SessionArchiveInspection[] = [];
  for (const session of plan.sessions) {
    const entry = entries.get(session.id);
    if (!entry || entry.startedAt !== session.startedAt) {
      throw new Error(`Session ${session.id} changed since the preview.`);
    }
    await verifySafeSessionDirectory(physicalRoot, entry.sessionDir, entry.id);
    inspections.push(await inspectArchive(entry.sessionDir, path.join(physicalArchive, entry.id), entry.id));
  }
  return inspections;
}

export function renderSessionArchiveInspection(inspections: readonly SessionArchiveInspection[]): string {
  return `${inspections
    .map(
      (inspection) =>
        `${inspection.status.padEnd(9)} ${formatTerminalValue(inspection.id)}${inspection.message ? ` — ${formatTerminalValue(inspection.message)}` : ""}`
    )
    .join("\n")}\n`;
}

async function inspectArchive(source: string, destination: string, id: string): Promise<SessionArchiveInspection> {
  try {
    if (await existsStrict(path.join(source, ARCHIVE_COMPLETE_FILE))) {
      throw new Error("Source session contains reserved archive completion metadata.");
    }
    if (!(await existsStrict(destination))) {
      return { id, status: "missing" };
    }
    await rejectLinks(destination);
    if (!(await lstat(destination)).isDirectory()) {
      throw new Error("Archive session is not a regular directory.");
    }
    const markerPath = path.join(destination, ARCHIVE_COMPLETE_FILE);
    const complete = await existsStrict(markerPath);
    await verifyArchiveSubset(source, destination, complete);
    if (complete) {
      const marker = await readJsonFileLimited<unknown>(markerPath, 4096);
      if (
        !isRecord(marker) ||
        marker.archiveVersion !== 1 ||
        marker.id !== id ||
        typeof marker.archivedAt !== "string" ||
        !Number.isFinite(Date.parse(marker.archivedAt))
      ) {
        throw new Error("Archive completion metadata is invalid.");
      }
    }
    return { id, status: complete ? "complete" : "resumable" };
  } catch (error) {
    return { id, status: "conflict", message: (error as Error).message };
  }
}

/** A leftover temporary copy is only ignorable when it belongs to a source file that has no final copy yet. */
function isInterruptedCopy(name: string, sourceNames: ReadonlySet<string>, copiedNames: readonly string[]): boolean {
  if (!name.endsWith(ARCHIVE_PARTIAL_SUFFIX) || sourceNames.has(name)) {
    return false;
  }
  const finalName = name.slice(0, -ARCHIVE_PARTIAL_SUFFIX.length);
  return sourceNames.has(finalName) && !copiedNames.includes(finalName);
}

async function verifyArchiveSubset(
  source: string,
  destination: string,
  complete: boolean,
  topLevel = true
): Promise<void> {
  const sourceNames = (await readdir(source)).sort();
  const sourceNamesSet = new Set(sourceNames);
  const destinationNames = (await readdir(destination)).filter((name) => !topLevel || name !== ARCHIVE_COMPLETE_FILE);
  const copiedNames = destinationNames
    .filter((name) => !isInterruptedCopy(name, sourceNamesSet, destinationNames))
    .sort();
  if (
    copiedNames.some((name) => !sourceNamesSet.has(name)) ||
    (complete && JSON.stringify(sourceNames) !== JSON.stringify(copiedNames))
  ) {
    throw new Error("Archived session contents differ from the source.");
  }
  for (const name of copiedNames) {
    const originalPath = path.join(source, name);
    const copiedPath = path.join(destination, name);
    const [original, copy] = await Promise.all([lstat(originalPath), lstat(copiedPath)]);
    if (original.isDirectory() && copy.isDirectory()) {
      await verifyArchiveSubset(originalPath, copiedPath, complete, false);
    } else if (original.isFile() && copy.isFile() && !original.isSymbolicLink() && !copy.isSymbolicLink()) {
      const [a, b] = await Promise.all([digestRegularFile(originalPath), digestRegularFile(copiedPath)]);
      if (a.bytes !== b.bytes || a.digest !== b.digest) {
        throw new Error("Archived session contents differ from the source.");
      }
    } else {
      throw new Error("Archived session contains a linked, special, or mismatched file.");
    }
  }
}

async function copyMissingArchiveFiles(source: string, destination: string, topLevel = true): Promise<void> {
  for (const name of await readdir(source)) {
    if (topLevel && name === ARCHIVE_COMPLETE_FILE) {
      throw new Error("Source session contains reserved archive completion metadata.");
    }
    const original = path.join(source, name);
    const copy = path.join(destination, name);
    const info = await lstat(original);
    if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile())) {
      throw new Error("Archived session contains a linked or special file.");
    }
    if (info.isDirectory()) {
      if (!(await existsStrict(copy))) {
        await mkdir(copy, { mode: 0o700 });
      }
      const copyInfo = await lstat(copy);
      if (!copyInfo.isDirectory() || copyInfo.isSymbolicLink()) {
        throw new Error("Archive directory changed during copying.");
      }
      await copyMissingArchiveFiles(original, copy, false);
    } else if (!(await existsStrict(copy))) {
      const partial = `${copy}${ARCHIVE_PARTIAL_SUFFIX}`;
      await rm(partial, { force: true });
      await cp(original, partial, { errorOnExist: true, force: false, dereference: false });
      await rename(partial, copy);
    }
  }
}

function indexCompleteEntries(entries: readonly SessionCatalogEntry[]): Map<string, SessionCatalogEntry> {
  return new Map(entries.filter((entry) => entry.state === "complete").map((entry) => [entry.id, entry]));
}

async function verifyRetentionSession(entry: SessionCatalogEntry, startedAt: string): Promise<void> {
  const verified = await readVerifiedCatalogSessionReportCore(entry);
  if (verified.report.startedAt !== startedAt) {
    throw new Error(
      `Session ${entry.id} has inconsistent catalog timestamps; verify and repair its indexes before retention.`
    );
  }
}

async function verifyRetentionCatalog(
  entries: readonly SessionCatalogEntry[],
  physicalRoot: string,
  plan: SessionRetentionPlan
): Promise<void> {
  // Even kept sessions influence chronology: a stale future timestamp could otherwise displace the newest session.
  for (const entry of entries) {
    if (entry.state !== "complete") {
      continue;
    }
    await verifySafeSessionDirectory(physicalRoot, entry.sessionDir, entry.id);
    if (entry.startedAt === undefined) {
      throw new Error(`Session ${entry.id} has no verified catalog timestamp; retention was cancelled.`);
    }
    await verifyRetentionSession(entry, entry.startedAt);
  }
  const current = planSessionRetention(entries, plan.before, plan.keep);
  if (JSON.stringify(current.sessions) !== JSON.stringify(plan.sessions)) {
    throw new Error("Session history changed since the preview; run retention again.");
  }
}

/**
 * Chooses the archive destination. An explicit `--to` is the caller's own decision and is used as given.
 * A destination read from repository configuration must stay physically inside the repository: a cloned
 * repository could otherwise redirect `abb sessions archive --apply` to write session copies anywhere the user can.
 */
export async function resolveArchiveDestination(
  repoRoot: string,
  explicitDestination: string | undefined,
  configuredDestination: string | undefined
): Promise<string | undefined> {
  if (explicitDestination !== undefined) {
    return explicitDestination;
  }
  if (configuredDestination === undefined) {
    return undefined;
  }
  if (!configuredDestination.trim() || /^(?:\\\\|\/\/)/.test(configuredDestination)) {
    throw new Error("retention.archiveDir must be a non-empty local path.");
  }

  const [physicalRepo, physicalAncestor] = await Promise.all([
    realpath(repoRoot),
    realpath(await nearestExistingAncestor(path.resolve(repoRoot, configuredDestination))),
  ]);
  if (!isPathInside(physicalRepo, physicalAncestor)) {
    throw new Error(
      "retention.archiveDir must stay inside the repository. Pass --to to choose an external destination explicitly."
    );
  }
  return configuredDestination;
}

async function nearestExistingAncestor(candidate: string): Promise<string> {
  let current = candidate;
  while (!(await existsStrict(current))) {
    const parent = path.dirname(current);
    if (parent === current) {
      return current;
    }
    current = parent;
  }
  return current;
}

export function renderSessionArchivePlan(plan: SessionRetentionPlan, archiveDir: string): string {
  const lines = [
    `Completed sessions before ${formatTerminalValue(plan.before)} (UTC), keeping the newest ${plan.keep}:`,
    `Archive destination: ${formatTerminalValue(archiveDir)}`,
    ...plan.sessions.map(
      (session) => `- ${formatTerminalValue(session.id)} | started ${formatTerminalValue(session.startedAt)}`
    ),
    `${plan.sessions.length} session(s) eligible for archival. Original sessions remain in place.`,
  ];
  return `${lines.join("\n")}\n`;
}

async function prepareArchiveRoot(repoRoot: string, sessionRoot: string, configuredPath: string): Promise<string> {
  if (!configuredPath.trim() || /^(?:\\\\|\/\/)/.test(configuredPath) || /^\\\\\?\\UNC\\/i.test(configuredPath)) {
    throw new Error("Archive destination must be a non-empty local path.");
  }
  const archivePath = path.resolve(repoRoot, configuredPath);
  const ancestor = await nearestExistingAncestor(archivePath);
  const physicalAncestor = await realpath(ancestor);
  const intendedArchive = path.resolve(physicalAncestor, path.relative(ancestor, archivePath));
  if (isPathInside(sessionRoot, archivePath) || isPathInside(sessionRoot, intendedArchive)) {
    throw new Error("Archive destination must stay outside the session root, including through links.");
  }
  await mkdir(archivePath, { recursive: true, mode: 0o700 });
  const info = await lstat(archivePath);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error("Archive destination is not a regular directory.");
  }
  const physicalArchive = await realpath(archivePath);
  if (isPathInside(sessionRoot, physicalArchive)) {
    throw new Error("Archive destination must stay outside the session root, including through links.");
  }
  return physicalArchive;
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
