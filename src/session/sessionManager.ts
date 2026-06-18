import { appendFile, open, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ActiveSession, AgentBlackBoxConfig, CommandEvent, FileEvent, SessionReport, StopRequest } from "../types.js";
import { collectGitSnapshot } from "../git/git.js";
import { detectRisks } from "../risks/riskDetector.js";
import { detectPossibleSecrets } from "../risks/secretDetector.js";
import { buildSessionReport } from "../reports/markdown.js";
import { writeReports } from "../reports/reportWriter.js";
import { ensureDir, getNewestDirectory, pathExists, readJsonFile, removeFileIfExists, writeJsonFile } from "../utils/files.js";

const ACTIVE_SESSION_FILE = "active-session.json";
const STOP_REQUEST_FILE = "stop-request.json";
const SESSION_LOCK_FILE = "session.lock";
const EVENTS_FILE = "events.ndjson";
const COMMANDS_FILE = "commands.ndjson";
const SESSION_START_FILE = "session-start.json";

interface SessionLock {
  sessionId: string;
  pid: number;
  createdAt: string;
  sessionDir: string;
}

interface StateReadResult<T> {
  value: T | null;
  corrupted: boolean;
  error?: string;
}

interface NdjsonReadResult<T> {
  records: T[];
  discardedLines: number;
  warnings: string[];
}

export function getSessionRoot(repoRoot: string, config: AgentBlackBoxConfig): string {
  return path.isAbsolute(config.sessionDir) ? config.sessionDir : path.join(repoRoot, config.sessionDir);
}

export function getStateDir(repoRoot: string, config: AgentBlackBoxConfig): string {
  return path.dirname(getSessionRoot(repoRoot, config));
}

export function getActiveSessionPath(repoRoot: string, config: AgentBlackBoxConfig): string {
  return path.join(getStateDir(repoRoot, config), ACTIVE_SESSION_FILE);
}

export function getStopRequestPath(repoRoot: string, config: AgentBlackBoxConfig): string {
  return path.join(getStateDir(repoRoot, config), STOP_REQUEST_FILE);
}

export function getSessionLockPath(repoRoot: string, config: AgentBlackBoxConfig): string {
  return path.join(getStateDir(repoRoot, config), SESSION_LOCK_FILE);
}

export function getEventsPath(sessionDir: string): string {
  return path.join(sessionDir, EVENTS_FILE);
}

export function getCommandsPath(sessionDir: string): string {
  return path.join(sessionDir, COMMANDS_FILE);
}

export async function createSession(repoRoot: string, config: AgentBlackBoxConfig): Promise<ActiveSession> {
  const startedAt = new Date().toISOString();
  const id = createSessionId(startedAt);
  const sessionDir = path.join(getSessionRoot(repoRoot, config), id);
  const session: ActiveSession = {
    id,
    repoRoot,
    sessionDir,
    startedAt,
    pid: process.pid
  };

  await ensureDir(getStateDir(repoRoot, config));
  await acquireSessionLock(repoRoot, config, {
    sessionId: session.id,
    pid: session.pid,
    createdAt: session.startedAt,
    sessionDir: session.sessionDir
  });

  try {
    const existingState = await readStateFile<ActiveSession>(getActiveSessionPath(repoRoot, config), isActiveSession);
    if (existingState.corrupted) {
      await quarantineStateFile(getActiveSessionPath(repoRoot, config));
    } else if (existingState.value && isProcessRunning(existingState.value.pid)) {
      await releaseSessionLock(repoRoot, config);
      throw new Error(`A session is already active: ${existingState.value.id}`);
    }

    await ensureDir(sessionDir);
    await writeFile(getEventsPath(sessionDir), "", "utf8");
    await writeFile(getCommandsPath(sessionDir), "", "utf8");
    await writeJsonFile(path.join(sessionDir, SESSION_START_FILE), session);
    await writeJsonFile(getActiveSessionPath(repoRoot, config), session);
    await removeFileIfExists(getStopRequestPath(repoRoot, config));

    return session;
  } catch (error) {
    await releaseSessionLock(repoRoot, config);
    throw error;
  }
}

export async function readActiveSession(repoRoot: string, config: AgentBlackBoxConfig): Promise<ActiveSession | null> {
  return (await readActiveSessionState(repoRoot, config)).value;
}

export async function readActiveSessionState(repoRoot: string, config: AgentBlackBoxConfig): Promise<StateReadResult<ActiveSession>> {
  return readStateFile(getActiveSessionPath(repoRoot, config), isActiveSession);
}

export async function readSessionLock(repoRoot: string, config: AgentBlackBoxConfig): Promise<SessionLock | null> {
  return (await readStateFile<SessionLock>(getSessionLockPath(repoRoot, config), isSessionLock)).value;
}

export async function writeStopRequest(
  repoRoot: string,
  config: AgentBlackBoxConfig,
  sessionId: string
): Promise<StopRequest> {
  const request = {
    sessionId,
    requestedAt: new Date().toISOString()
  };
  await writeJsonFile(getStopRequestPath(repoRoot, config), request);
  return request;
}

export async function readStopRequest(repoRoot: string, config: AgentBlackBoxConfig): Promise<StopRequest | null> {
  const requestPath = getStopRequestPath(repoRoot, config);
  if (!(await pathExists(requestPath))) {
    return null;
  }

  return readJsonFile<StopRequest>(requestPath);
}

export async function appendFileEvent(session: ActiveSession, event: FileEvent): Promise<void> {
  await appendFile(getEventsPath(session.sessionDir), `${JSON.stringify(event)}\n`, "utf8");
}

export async function appendCommandEvent(session: ActiveSession, event: CommandEvent): Promise<void> {
  await appendFile(getCommandsPath(session.sessionDir), `${JSON.stringify(event)}\n`, "utf8");
}

export async function readFileEvents(sessionDir: string): Promise<FileEvent[]> {
  return (await readFileEventsWithDiagnostics(sessionDir)).records;
}

export async function readCommandEvents(sessionDir: string): Promise<CommandEvent[]> {
  return (await readCommandEventsWithDiagnostics(sessionDir)).records;
}

export async function readFileEventsWithDiagnostics(sessionDir: string): Promise<NdjsonReadResult<FileEvent>> {
  return readNdjsonRecords(getEventsPath(sessionDir), isFileEvent, "file event");
}

export async function readCommandEventsWithDiagnostics(sessionDir: string): Promise<NdjsonReadResult<CommandEvent>> {
  return readNdjsonRecords(getCommandsPath(sessionDir), isCommandEvent, "command event");
}

export async function finalizeSession(
  active: ActiveSession,
  config: AgentBlackBoxConfig,
  finalizedBy: string
): Promise<SessionReport> {
  const endedAt = new Date().toISOString();
  const fileEvents = await readFileEventsWithDiagnostics(active.sessionDir);
  const commandEvents = await readCommandEventsWithDiagnostics(active.sessionDir);
  const git = await collectGitSnapshot(active.repoRoot, config.exclude);
  const risks = detectRisks(git.changedFiles, config);
  const possibleSecrets = await detectPossibleSecrets(active.repoRoot, git.changedFiles, config);
  const report = buildSessionReport(active, endedAt, finalizedBy, fileEvents.records, commandEvents.records, git, risks, possibleSecrets, {
    warnings: [...fileEvents.warnings, ...commandEvents.warnings],
    discardedFileEventLines: fileEvents.discardedLines,
    discardedCommandEventLines: commandEvents.discardedLines
  });

  await writeReports(report);
  await removeFileIfExists(getActiveSessionPath(active.repoRoot, config));
  await removeFileIfExists(getStopRequestPath(active.repoRoot, config));
  await releaseSessionLock(active.repoRoot, config);

  return report;
}

export async function getLatestSessionDir(repoRoot: string, config: AgentBlackBoxConfig): Promise<string | null> {
  return getNewestDirectory(getSessionRoot(repoRoot, config));
}

export function isProcessRunning(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function createSessionId(startedAt: string): string {
  const safeTimestamp = startedAt.replace(/[:.]/g, "-");
  return `session-${safeTimestamp}`;
}

async function acquireSessionLock(repoRoot: string, config: AgentBlackBoxConfig, lock: SessionLock): Promise<void> {
  const lockPath = getSessionLockPath(repoRoot, config);

  try {
    const handle = await open(lockPath, "wx");
    try {
      await handle.writeFile(`${JSON.stringify(lock, null, 2)}\n`, "utf8");
    } finally {
      await handle.close();
    }
    return;
  } catch (error) {
    if (!isFileExistsError(error)) {
      throw error;
    }
  }

  const existing = await readStateFile<SessionLock>(lockPath, isSessionLock);
  if (existing.value && isProcessRunning(existing.value.pid)) {
    throw new Error(`A session lock is already active for ${existing.value.sessionId}.`);
  }

  await removeFileIfExists(lockPath);
  await acquireSessionLock(repoRoot, config, lock);
}

async function releaseSessionLock(repoRoot: string, config: AgentBlackBoxConfig): Promise<void> {
  await removeFileIfExists(getSessionLockPath(repoRoot, config));
}

async function readStateFile<T>(filePath: string, guard: (value: unknown) => value is T): Promise<StateReadResult<T>> {
  if (!(await pathExists(filePath))) {
    return { value: null, corrupted: false };
  }

  try {
    const value = JSON.parse(await readFile(filePath, "utf8")) as unknown;
    if (!guard(value)) {
      return { value: null, corrupted: true, error: "State file has an unexpected shape." };
    }
    return { value, corrupted: false };
  } catch (error) {
    return { value: null, corrupted: true, error: (error as Error).message };
  }
}

async function quarantineStateFile(filePath: string): Promise<void> {
  if (!(await pathExists(filePath))) {
    return;
  }

  const suffix = new Date().toISOString().replace(/[:.]/g, "-");
  await rename(filePath, `${filePath}.corrupt-${suffix}`);
}

async function readNdjsonRecords<T>(
  filePath: string,
  guard: (value: unknown) => value is T,
  label: string
): Promise<NdjsonReadResult<T>> {
  if (!(await pathExists(filePath))) {
    return { records: [], discardedLines: 0, warnings: [] };
  }

  const raw = await readFile(filePath, "utf8");
  const records: T[] = [];
  const warnings: string[] = [];
  let discardedLines = 0;

  raw.split(/\r?\n/).forEach((line, index) => {
    if (!line) {
      return;
    }

    try {
      const parsed = JSON.parse(line) as unknown;
      if (guard(parsed)) {
        records.push(parsed);
        return;
      }
      discardedLines += 1;
      warnings.push(`Discarded malformed ${label} on line ${index + 1}.`);
    } catch {
      discardedLines += 1;
      warnings.push(`Discarded unreadable ${label} on line ${index + 1}.`);
    }
  });

  return { records, discardedLines, warnings };
}

function isActiveSession(value: unknown): value is ActiveSession {
  if (!isRecord(value)) {
    return false;
  }

  return (
    typeof value.id === "string" &&
    typeof value.repoRoot === "string" &&
    typeof value.sessionDir === "string" &&
    typeof value.startedAt === "string" &&
    Number.isInteger(value.pid)
  );
}

function isSessionLock(value: unknown): value is SessionLock {
  if (!isRecord(value)) {
    return false;
  }

  return (
    typeof value.sessionId === "string" &&
    typeof value.createdAt === "string" &&
    typeof value.sessionDir === "string" &&
    Number.isInteger(value.pid)
  );
}

function isFileEvent(value: unknown): value is FileEvent {
  if (!isRecord(value)) {
    return false;
  }

  return (
    typeof value.timestamp === "string" &&
    typeof value.path === "string" &&
    (value.eventType === "add" || value.eventType === "change" || value.eventType === "unlink")
  );
}

function isCommandEvent(value: unknown): value is CommandEvent {
  if (!isRecord(value)) {
    return false;
  }

  return (
    typeof value.startedAt === "string" &&
    typeof value.endedAt === "string" &&
    typeof value.command === "string" &&
    typeof value.cwd === "string" &&
    (typeof value.label === "string" || value.label === undefined) &&
    (typeof value.exitCode === "number" || value.exitCode === null) &&
    typeof value.durationMs === "number" &&
    (typeof value.error === "string" || value.error === undefined)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFileExistsError(error: unknown): boolean {
  return isRecord(error) && error.code === "EEXIST";
}
